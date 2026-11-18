import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type {
  DocumentationEmbeddingProvider,
  DocumentationEmbeddingVector,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import {
  DocumentationEmbeddingSpaceSchema,
  QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import { DocumentationBuildManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  validateDocumentationEmbeddingSet,
  validateDocumentationEmbeddingTable,
  inspectDocumentationEmbeddingTable,
  writeDocumentationEmbeddings,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-embeddings.js';
import { DOCUMENTATION_EMBEDDINGS_TABLE } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import {
  getCatalogIndex,
  listCatalogEmbeddingStatusCandidates,
  listCatalogIndexes,
  updateSnapshot,
  validateSnapshotDirectory,
  type CatalogOptions,
  type DocumentationCatalogEntry,
} from './catalog.js';
import type { ModelStatus } from './model-manager.js';

const EMBEDDING_BATCH_SIZE = 8;

export interface EmbeddingWorkflowOptions extends CatalogOptions {
  /** Deterministic provider injection for tests and embedding hosts. */
  embeddingProvider?: DocumentationEmbeddingProvider;
  modelStatusReader?: () => Promise<ModelStatus>;
  onProgress?: (progress: EmbeddingBuildProgress) => void;
  signal?: AbortSignal;
}

export interface EmbeddingBuildProgress {
  selector: string;
  phase: 'checking' | 'embedding' | 'validating' | 'activated' | 'complete';
  completedChunks: number;
  totalChunks: number;
}

export interface EmbeddingBuildItemResult {
  selector: string;
  totalChunks: number;
  generatedChunks: number;
  reusedChunks: number;
  changed: boolean;
}

export interface EmbeddingSnapshotStatus {
  selector: string;
  modelCompatibility: 'not built' | 'compatible' | 'incompatible';
  totalChunks: number;
  embeddedChunks: number;
  missingEmbeddings: number;
  invalidEmbeddings: number;
  completionPercent: number;
  snapshotIntegrity: 'valid' | 'invalid';
}

/** Generate missing vectors from persisted canonical chunks, then promote. */
export async function buildDocumentationEmbeddings(
  selector?: string,
  options: EmbeddingWorkflowOptions = {},
): Promise<EmbeddingBuildItemResult[]> {
  const entries = await selectInstalledSnapshots(selector, options);
  const targets = entries.filter(
    (entry) =>
      !isDeepStrictEqual(
        entry.manifest.embeddings,
        QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      ),
  );

  if (targets.length === 0) {
    return entries.map((entry) => ({
      selector: snapshotSelector(entry),
      totalChunks: entry.manifest.index.chunkCount,
      generatedChunks: 0,
      reusedChunks: entry.manifest.index.chunkCount,
      changed: false,
    }));
  }

  const provider =
    options.embeddingProvider ??
    (await createInstalledLocalProvider(options.modelStatusReader));
  const results: EmbeddingBuildItemResult[] = [];
  for (const entry of entries) {
    throwIfAborted(options.signal);
    const totalChunks = entry.manifest.index.chunkCount;
    const selectorId = snapshotSelector(entry);
    if (isDeepStrictEqual(entry.manifest.embeddings, provider.embeddingSpace)) {
      results.push({
        selector: selectorId,
        totalChunks,
        generatedChunks: 0,
        reusedChunks: totalChunks,
        changed: false,
      });
      options.onProgress?.({
        selector: selectorId,
        phase: 'complete',
        completedChunks: totalChunks,
        totalChunks,
      });
      continue;
    }

    options.onProgress?.({
      selector: selectorId,
      phase: 'checking',
      completedChunks: 0,
      totalChunks,
    });
    results.push(await buildSnapshotEmbeddings(entry, provider, options));
  }
  return results;
}

/** Report vector coverage for every installed source, or one selector. */
export async function getDocumentationEmbeddingStatuses(
  selector?: string,
  options: CatalogOptions = {},
): Promise<EmbeddingSnapshotStatus[]> {
  const candidates = await listCatalogEmbeddingStatusCandidates(options);
  const selected = selector
    ? candidates.filter(
        (candidate) => `${candidate.source}@${candidate.version}` === selector,
      )
    : candidates;
  if (selector && selected.length === 0) {
    throw new Error(`No installed snapshot exists for ${selector}`);
  }
  return selected.map((candidate) => {
    const totalChunks = candidate.manifest.index.chunkCount;
    const database = new DatabaseSync(candidate.databasePath, {
      readOnly: true,
      timeout: 5000,
    });
    let inspection;
    try {
      inspection = inspectDocumentationEmbeddingTable(
        database,
        candidate.manifest.embeddings,
        new Set(
          candidate.corpus.documents.flatMap((document) =>
            document.chunks.map((chunk) => chunk.id),
          ),
        ),
      );
    } finally {
      database.close();
    }
    const compatible = isDeepStrictEqual(
      candidate.manifest.embeddings,
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    );
    const embeddedChunks = compatible ? inspection.validChunkIds.size : 0;
    return {
      selector: `${candidate.source}@${candidate.version}`,
      modelCompatibility: compatible
        ? 'compatible'
        : candidate.manifest.embeddings
          ? 'incompatible'
          : 'not built',
      totalChunks,
      embeddedChunks,
      missingEmbeddings: totalChunks - embeddedChunks,
      invalidEmbeddings: inspection.invalidRows,
      completionPercent:
        totalChunks === 0
          ? 100
          : Math.round((embeddedChunks / totalChunks) * 100),
      snapshotIntegrity: candidate.indexChecksumValid ? 'valid' : 'invalid',
    };
  });
}

export function formatDocumentationEmbeddingStatuses(
  statuses: readonly EmbeddingSnapshotStatus[],
): string {
  const header = [
    'SOURCE',
    'MODEL COMPATIBILITY',
    'TOTAL CHUNKS',
    'EMBEDDED',
    'MISSING',
    'INVALID',
    'COMPLETE',
    'SNAPSHOT INTEGRITY',
  ].join('\t');
  return [
    header,
    ...statuses.map((status) =>
      [
        status.selector,
        status.modelCompatibility,
        String(status.totalChunks),
        String(status.embeddedChunks),
        String(status.missingEmbeddings),
        String(status.invalidEmbeddings),
        `${status.completionPercent}%`,
        status.snapshotIntegrity,
      ].join('\t'),
    ),
  ].join('\n');
}

async function selectInstalledSnapshots(
  selector: string | undefined,
  options: CatalogOptions,
): Promise<DocumentationCatalogEntry[]> {
  if (selector) {
    const entry = await getCatalogIndex(selector, options);
    if (!entry) {
      throw new Error(`No snapshot exists for ${selector}`);
    }
    if (entry.status !== 'installed') {
      throw new Error(
        `Embeddings can only be built for installed snapshots; ${selector} is bundled`,
      );
    }
    return [entry];
  }
  return (await listCatalogIndexes(options)).filter(
    (entry) => entry.status === 'installed',
  );
}

async function buildSnapshotEmbeddings(
  entry: DocumentationCatalogEntry,
  provider: DocumentationEmbeddingProvider,
  options: EmbeddingWorkflowOptions,
): Promise<EmbeddingBuildItemResult> {
  const selector = snapshotSelector(entry);
  const snapshotDirectory = dirname(entry.databasePath);
  const snapshot = await validateSnapshotDirectory(snapshotDirectory);
  const corpus = DocumentationCorpusSchema.parse(
    JSON.parse(snapshot.files.corpus.toString('utf8')) as unknown,
  );
  const manifest = DocumentationBuildManifestSchema.parse(
    JSON.parse(snapshot.files.manifest.toString('utf8')) as unknown,
  );
  const chunks = corpus.documents.flatMap((document) => document.chunks);
  if (chunks.length !== entry.manifest.index.chunkCount) {
    throw new Error(
      `Canonical corpus chunk count changed for ${selector}; refusing to build embeddings`,
    );
  }
  const embeddingSpace = DocumentationEmbeddingSpaceSchema.parse(
    provider.embeddingSpace,
  );
  const vectors: DocumentationEmbeddingVector[] = [];

  for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    throwIfAborted(options.signal);
    const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const generated = await provider.embedDocuments(
      batch.map((chunk) => chunk.markdown),
    );
    if (generated.length !== batch.length) {
      throw new Error(
        `Embedding generation returned ${generated.length} vectors for ${batch.length} chunks in ${selector}`,
      );
    }
    batch.forEach((chunk, index) => {
      const vector = generated[index];
      if (!vector) {
        throw new Error(`Embedding generation omitted chunk ${chunk.id}`);
      }
      vectors.push({ chunkId: chunk.id, vector });
    });
    options.onProgress?.({
      selector,
      phase: 'embedding',
      completedChunks: Math.min(offset + batch.length, chunks.length),
      totalChunks: chunks.length,
    });
  }
  throwIfAborted(options.signal);
  const completeSet = {
    embeddingSpace,
    vectors: validateDocumentationEmbeddingSet(
      { embeddingSpace, vectors },
      chunks.map((chunk) => chunk.id),
    ),
  };

  const stagingDirectory = await mkdtemp(
    join(tmpdir(), 'nekosearch-embedding-build-'),
  );
  const stagedIndexPath = join(stagingDirectory, 'index.sqlite');
  try {
    await writeFile(
      join(stagingDirectory, 'corpus.json'),
      snapshot.files.corpus,
      { flag: 'wx', mode: 0o600 },
    );
    await copyFile(entry.databasePath, stagedIndexPath);

    const database = new DatabaseSync(stagedIndexPath, { timeout: 5000 });
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(`DROP TABLE IF EXISTS ${DOCUMENTATION_EMBEDDINGS_TABLE}`);
        writeDocumentationEmbeddings(database, completeSet.vectors);
        validateDocumentationEmbeddingTable(
          database,
          embeddingSpace,
          new Set(chunks.map((chunk) => chunk.id)),
          new Set(chunks.map((chunk) => chunk.id)),
        );
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      database.close();
    }

    const indexSha256 = await sha256File(stagedIndexPath);
    const updatedManifest = DocumentationBuildManifestSchema.parse({
      ...manifest,
      embeddings: embeddingSpace,
      index: { ...manifest.index, sha256: indexSha256 },
    });
    await writeFile(
      join(stagingDirectory, 'manifest.json'),
      `${JSON.stringify(updatedManifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    options.onProgress?.({
      selector,
      phase: 'validating',
      completedChunks: chunks.length,
      totalChunks: chunks.length,
    });
    await validateSnapshotDirectory(stagingDirectory);
    throwIfAborted(options.signal);
    const updated = await updateSnapshot(stagingDirectory, options, {
      expectedCurrent: {
        source: entry.source,
        version: entry.version,
        revision: entry.revision,
        directoryKey: basename(snapshotDirectory),
      },
    });
    options.onProgress?.({
      selector,
      phase: 'activated',
      completedChunks: chunks.length,
      totalChunks: chunks.length,
    });
    return {
      selector,
      totalChunks: chunks.length,
      generatedChunks: vectors.length,
      reusedChunks: 0,
      changed: updated.changed,
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function createInstalledLocalProvider(
  modelStatusReader?: () => Promise<ModelStatus>,
): Promise<DocumentationEmbeddingProvider> {
  const status = await (
    modelStatusReader ??
    (async () => {
      const manager = await import('./model-manager.js');
      return manager.getModelStatus();
    })
  )();
  if (
    status.installationState !== 'installed' ||
    status.artifactIntegrity !== 'valid'
  ) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `Qwen3 is not installed and verified at ${status.modelDirectory}.${details} Run \`nekosearch model install\`; embeddings build never downloads the model implicitly.`,
    );
  }
  if (!status.inferenceAvailable) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `The local inference runtime is unavailable.${details} Install @huggingface/transformers@4.3.2 on a supported Node.js host before retrying.`,
    );
  }
  const runtime = await import('./local-qwen3-embedding-generator.js');
  const generator = runtime.createLocalQwen3EmbeddingGenerator();
  return {
    embeddingSpace: runtime.LOCAL_QWEN3_EMBEDDING_SPACE,
    embedDocuments: (documents) => generator.embedDocuments(documents),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error(
    'Embedding build was interrupted before snapshot activation',
    {
      cause: signal.reason,
    },
  );
}

function snapshotSelector(entry: DocumentationCatalogEntry): string {
  return `${entry.source}@${entry.version}`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}
