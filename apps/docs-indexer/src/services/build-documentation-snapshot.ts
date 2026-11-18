import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  DocumentationCorpus,
  DocumentationIdentity,
  DocumentationSnapshot,
  DocumentationSourceProvenance,
  DocumentationVersion,
  NormalizedDocument,
  SourceDocument,
} from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import type {
  DocumentationEmbeddingProvider,
  DocumentationEmbeddingSet,
  DocumentationEmbeddingSpace,
  DocumentationEmbeddingVector,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { DocumentationEmbeddingSpaceSchema } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import {
  DocumentationCorpusSchema,
  DocumentationSnapshotSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import type { DocumentationDocumentTransformer } from '@nestjs-docs/documentation-engine/application/contracts/documentation-transformer.contract.js';
import { ingestSnapshot } from '@nestjs-docs/documentation-engine/application/services/documentation-ingestion.service.js';
import {
  DOCUMENT_CHUNKING_ALGORITHM_VERSION,
  DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/document-normalizer.js';
import {
  MARKDOWN_PARSER_VERSION,
  type MarkdownDiagnostic,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/markdown-parser.js';
import {
  DOCUMENTATION_INDEX_FORMAT_VERSION,
  DOCUMENTATION_INDEX_SCHEMA_VERSION,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import {
  DOCUMENTATION_LINK_RESOLVER_VERSION,
  resolveInternalDocumentationLinks,
} from '@nestjs-docs/documentation-engine/infrastructure/markdown/documentation-link-resolver.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import {
  readDocumentationEmbeddingVectors,
  validateDocumentationEmbeddingSet,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-embeddings.js';
import {
  DOCUMENTATION_BUILD_MANIFEST_VERSION,
  DocumentationBuildManifestSchema,
} from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';

const CORPUS_FILENAME = 'corpus.json';
const INDEX_FILENAME = 'index.sqlite';
const MANIFEST_FILENAME = 'manifest.json';

export type DocumentationBuildMode = 'clean' | 'incremental';

export interface DocumentationBuildChanges {
  added: number;
  modified: number;
  unchanged: number;
  removed: number;
}

interface DocumentationPipelineMetadata {
  parserVersion: number;
  transformerVersion: number;
  normalizationAlgorithmVersion: number;
  chunkingAlgorithmVersion: number;
  maxChunkChars: number;
  indexSchemaVersion: number;
  indexFormatVersion: number;
  linkResolverVersion: number;
}

interface PreviousDocumentationBuild {
  directory: string;
  corpus: DocumentationCorpus;
  pipelineMatches: boolean;
  embeddingSpace?: DocumentationEmbeddingSpace;
}

export interface DocumentationBuildDiagnostic extends MarkdownDiagnostic {
  path: string;
}

export interface DocumentationBuildSummary {
  id: string;
  version: DocumentationVersion;
  sourceRevision: string;
  outputDirectory: string;
  documentCount: number;
  chunkCount: number;
  diagnostics: DocumentationBuildDiagnostic[];
  mode: DocumentationBuildMode;
  changes: DocumentationBuildChanges;
  cleanupWarning?: string;
}

export interface DocumentationSnapshotBuildRequest {
  identity: DocumentationIdentity;
  snapshot: DocumentationSnapshot;
  transformDocument: DocumentationDocumentTransformer;
  transformerVersion: number;
  outputDirectory: string;
  previousOutputDirectory?: string;
  mode?: DocumentationBuildMode;
  maxChunkChars?: number;
  diagnostics?: DocumentationBuildDiagnostic[];
  /** Omit for a lexical-only snapshot; provide one complete set for hybrid. */
  embeddingSet?: DocumentationEmbeddingSet;
  /** Provide to generate vectors locally and reuse compatible prior vectors. */
  embeddingProvider?: DocumentationEmbeddingProvider;
}

/** Incrementally reuse validated prior documents and index rows, then promote. */
export async function buildDocumentationSnapshot(
  request: DocumentationSnapshotBuildRequest,
): Promise<DocumentationBuildSummary> {
  const snapshot = DocumentationSnapshotSchema.parse(request.snapshot);
  if (request.identity.version !== snapshot.version) {
    throw new Error(
      'Documentation identity version must match the source snapshot',
    );
  }
  if (request.embeddingSet && request.embeddingProvider) {
    throw new Error(
      'Provide either a complete embedding set or an embedding provider, not both',
    );
  }
  const maxChunkChars = request.maxChunkChars ?? 4000;
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 1) {
    throw new Error('maxChunkChars must be a positive integer');
  }
  if (
    !Number.isSafeInteger(request.transformerVersion) ||
    request.transformerVersion < 1
  ) {
    throw new Error('transformerVersion must be a positive integer');
  }
  const mode = request.mode ?? 'incremental';
  if (mode !== 'clean' && mode !== 'incremental') {
    throw new Error('Build mode must be "clean" or "incremental"');
  }
  const outputDirectory = await prepareDocumentationOutputDirectory(
    request.outputDirectory,
    snapshot.source.kind === 'local' ? snapshot.source.root : undefined,
  );
  const pipeline: DocumentationPipelineMetadata = {
    parserVersion: MARKDOWN_PARSER_VERSION,
    transformerVersion: request.transformerVersion,
    normalizationAlgorithmVersion: DOCUMENT_NORMALIZATION_ALGORITHM_VERSION,
    chunkingAlgorithmVersion: DOCUMENT_CHUNKING_ALGORITHM_VERSION,
    maxChunkChars,
    indexSchemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
    indexFormatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
    linkResolverVersion: DOCUMENTATION_LINK_RESOLVER_VERSION,
  };
  const previous =
    mode === 'incremental'
      ? await loadPreviousBuild(
          request.previousOutputDirectory ?? outputDirectory,
          request.identity,
          snapshot.source,
          pipeline,
        )
      : undefined;
  const previousByPath = new Map(
    previous?.corpus.documents.map((document) => [
      document.source.path,
      document,
    ]) ?? [],
  );
  const changes = determineBuildChanges(
    snapshot.documents,
    previousByPath,
    previous?.pipelineMatches ?? false,
  );
  const ingestedCorpus = ingestSnapshot(
    snapshot,
    request.transformDocument,
    maxChunkChars,
    {
      reuseDocument: (file, source) => {
        if (!previous?.pipelineMatches) return undefined;
        const cached = previousByPath.get(file.path);
        if (
          !cached ||
          cached.version !== file.version ||
          cached.canonicalUrl !== file.canonicalUrl ||
          cached.source.contentHash !== sha256(file.markdown)
        ) {
          return undefined;
        }
        return reuseNormalizedDocument(cached, file, source);
      },
    },
  );
  const corpus = resolveInternalDocumentationLinks(ingestedCorpus);
  const stagingDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.staging-`),
  );

  try {
    const corpusPath = join(stagingDirectory, CORPUS_FILENAME);
    const indexPath = join(stagingDirectory, INDEX_FILENAME);
    const manifestPath = join(stagingDirectory, MANIFEST_FILENAME);
    const corpusContents = `${JSON.stringify(corpus, null, 2)}\n`;
    await writeFile(corpusPath, corpusContents, 'utf8');

    const embeddingSet =
      request.embeddingSet ??
      (request.embeddingProvider
        ? await generateEmbeddingSet(
            corpus,
            request.embeddingProvider,
            previous,
          )
        : undefined);

    if (previous?.pipelineMatches) {
      await copyFile(join(previous.directory, INDEX_FILENAME), indexPath);
    }

    const writer = new DocumentationIndexWriter(
      indexPath,
      request.identity.version,
    );
    try {
      writer.indexCorpus(corpus, embeddingSet);
    } finally {
      writer.close();
    }

    const { documentCount, chunkCount } = validateDocumentationIndex(
      request.identity.version,
      corpus,
      indexPath,
      embeddingSet?.embeddingSpace,
    );
    const manifest = DocumentationBuildManifestSchema.parse({
      manifestVersion: DOCUMENTATION_BUILD_MANIFEST_VERSION,
      snapshotFormatVersion: 2,
      documentation: request.identity,
      source: corpus.source,
      ...(embeddingSet && {
        embeddings: embeddingSet.embeddingSpace,
      }),
      pipeline,
      corpus: {
        formatVersion: 2,
        file: CORPUS_FILENAME,
        sha256: sha256(corpusContents),
        documentCount,
        documents: [...corpus.documents]
          .sort((left, right) =>
            compareStrings(left.source.path, right.source.path),
          )
          .map((document) => ({
            id: document.id,
            path: document.source.path,
            sourceContentHash: document.source.contentHash,
            normalizedContentHash: document.contentHash,
          })),
      },
      index: {
        file: INDEX_FILENAME,
        sha256: await sha256File(indexPath),
        documentationVersion: request.identity.version,
        sourceRevision: corpus.source.revision,
        schemaVersion: DOCUMENTATION_INDEX_SCHEMA_VERSION,
        formatVersion: DOCUMENTATION_INDEX_FORMAT_VERSION,
        documentCount,
        chunkCount,
      },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const cleanupWarning = await promoteDocumentationOutput(
      stagingDirectory,
      outputDirectory,
    );

    return {
      id: request.identity.id,
      version: request.identity.version,
      sourceRevision: corpus.source.revision,
      outputDirectory,
      documentCount,
      chunkCount,
      diagnostics: request.diagnostics ?? [],
      mode,
      changes,
      ...(cleanupWarning && { cleanupWarning }),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function loadPreviousBuild(
  directory: string,
  identity: DocumentationIdentity,
  source: DocumentationSourceProvenance,
  pipeline: DocumentationPipelineMetadata,
): Promise<PreviousDocumentationBuild | undefined> {
  try {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return undefined;
    }
    const manifestPath = join(directory, MANIFEST_FILENAME);
    const corpusPath = join(directory, CORPUS_FILENAME);
    const indexPath = join(directory, INDEX_FILENAME);
    for (const path of [manifestPath, corpusPath, indexPath]) {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return undefined;
    }

    const manifest = DocumentationBuildManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
    );
    if (
      !isDeepStrictEqual(manifest.documentation, identity) ||
      !sameSourceIdentity(manifest.source, source)
    ) {
      return undefined;
    }

    const corpusBytes = await readFile(corpusPath);
    if (sha256(corpusBytes) !== manifest.corpus.sha256) return undefined;
    const corpus = DocumentationCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')) as unknown,
    );
    if (
      corpus.version !== identity.version ||
      !isDeepStrictEqual(corpus.source, manifest.source) ||
      !isDeepStrictEqual(
        [...corpus.documents]
          .sort((left, right) =>
            compareStrings(left.source.path, right.source.path),
          )
          .map((document) => ({
            id: document.id,
            path: document.source.path,
            sourceContentHash: document.source.contentHash,
            normalizedContentHash: document.contentHash,
          })),
        manifest.corpus.documents,
      )
    ) {
      return undefined;
    }
    if (
      (await sha256File(indexPath)) !== manifest.index.sha256 ||
      manifest.index.documentationVersion !== identity.version
    ) {
      return undefined;
    }

    const indexFormatMatches =
      manifest.index.schemaVersion === DOCUMENTATION_INDEX_SCHEMA_VERSION &&
      manifest.index.formatVersion === DOCUMENTATION_INDEX_FORMAT_VERSION;
    if (!indexFormatMatches) {
      return { directory, corpus, pipelineMatches: false };
    }

    const validated = validateDocumentationIndex(
      identity.version,
      corpus,
      indexPath,
      manifest.embeddings,
    );
    if (
      validated.documentCount !== manifest.corpus.documentCount ||
      validated.documentCount !== manifest.index.documentCount ||
      validated.chunkCount !== manifest.index.chunkCount ||
      manifest.index.sourceRevision !== corpus.source.revision
    ) {
      return undefined;
    }

    return {
      directory,
      corpus,
      pipelineMatches: isDeepStrictEqual(manifest.pipeline, pipeline),
      ...(manifest.embeddings && { embeddingSpace: manifest.embeddings }),
    };
  } catch {
    // An invalid or unreadable prior build is never trusted. The caller makes
    // a clean build and only replaces it after the new output validates.
    return undefined;
  }
}

async function generateEmbeddingSet(
  corpus: DocumentationCorpus,
  provider: DocumentationEmbeddingProvider,
  previous: PreviousDocumentationBuild | undefined,
): Promise<DocumentationEmbeddingSet> {
  const parsedSpace = DocumentationEmbeddingSpaceSchema.safeParse(
    provider.embeddingSpace,
  );
  if (!parsedSpace.success) {
    throw new Error('Embedding provider metadata is incompatible with Qwen3');
  }

  const chunks = corpus.documents.flatMap((document) => document.chunks);
  const previousChunks = new Map(
    previous?.corpus.documents.flatMap((document) =>
      document.chunks.map((chunk) => [chunk.id, chunk] as const),
    ) ?? [],
  );
  const reusableVectors = new Map<string, Float32Array>();
  if (
    previous?.embeddingSpace &&
    isDeepStrictEqual(previous.embeddingSpace, parsedSpace.data)
  ) {
    const previousChunkIds = new Set(
      previous.corpus.documents.flatMap((document) =>
        document.chunks.map((chunk) => chunk.id),
      ),
    );
    const previousDatabase = new DatabaseSync(
      join(previous.directory, INDEX_FILENAME),
      { readOnly: true },
    );
    try {
      for (const vector of readDocumentationEmbeddingVectors(
        previousDatabase,
        previous.embeddingSpace,
        previousChunkIds,
      )) {
        reusableVectors.set(vector.chunkId, vector.vector);
      }
    } finally {
      previousDatabase.close();
    }
  }

  const vectors: DocumentationEmbeddingVector[] = [];
  const chunksNeedingEmbeddings: typeof chunks = [];
  for (const chunk of chunks) {
    const previousChunk = previousChunks.get(chunk.id);
    const previousVector = reusableVectors.get(chunk.id);
    if (
      previousChunk &&
      previousVector &&
      previousChunk.documentId === chunk.documentId &&
      previousChunk.contentHash === chunk.contentHash &&
      previousChunk.markdown === chunk.markdown
    ) {
      vectors.push({ chunkId: chunk.id, vector: previousVector });
    } else {
      chunksNeedingEmbeddings.push(chunk);
    }
  }

  if (chunksNeedingEmbeddings.length > 0) {
    const generatedVectors = await provider.embedDocuments(
      chunksNeedingEmbeddings.map((chunk) => chunk.markdown),
    );
    if (generatedVectors.length !== chunksNeedingEmbeddings.length) {
      throw new Error(
        `Embedding generation returned ${generatedVectors.length} vectors for ${chunksNeedingEmbeddings.length} chunks`,
      );
    }
    chunksNeedingEmbeddings.forEach((chunk, index) => {
      const vector = generatedVectors[index];
      if (!vector) {
        throw new Error(`Embedding generation omitted chunk ${chunk.id}`);
      }
      vectors.push({ chunkId: chunk.id, vector });
    });
  }

  return {
    embeddingSpace: parsedSpace.data,
    vectors: validateDocumentationEmbeddingSet(
      { embeddingSpace: parsedSpace.data, vectors },
      chunks.map((chunk) => chunk.id),
    ),
  };
}

function sameSourceIdentity(
  previous: DocumentationSourceProvenance,
  current: DocumentationSourceProvenance,
): boolean {
  if (previous.kind !== current.kind) return false;
  return previous.kind === 'local' && current.kind === 'local'
    ? previous.root === current.root
    : previous.kind === 'git' &&
        current.kind === 'git' &&
        previous.repository === current.repository;
}

function determineBuildChanges(
  files: SourceDocument[],
  previousByPath: ReadonlyMap<string, NormalizedDocument>,
  pipelineMatches: boolean,
): DocumentationBuildChanges {
  const changes: DocumentationBuildChanges = {
    added: 0,
    modified: 0,
    unchanged: 0,
    removed: 0,
  };
  const currentPaths = new Set<string>();
  for (const file of files) {
    currentPaths.add(file.path);
    const previous = previousByPath.get(file.path);
    if (!previous) {
      changes.added++;
    } else if (
      !pipelineMatches ||
      previous.version !== file.version ||
      previous.canonicalUrl !== file.canonicalUrl ||
      previous.source.contentHash !== sha256(file.markdown)
    ) {
      changes.modified++;
    } else {
      changes.unchanged++;
    }
  }
  changes.removed = [...previousByPath.keys()].filter(
    (path) => !currentPaths.has(path),
  ).length;
  return changes;
}

function reuseNormalizedDocument(
  cached: NormalizedDocument,
  file: SourceDocument,
  source: DocumentationSourceProvenance,
): NormalizedDocument {
  return {
    ...cached,
    source: {
      ...cached.source,
      provenance: source,
      path: file.path,
      location: file.sourceLocation,
      contentHash: sha256(file.markdown),
    },
    chunks: cached.chunks.map((chunk) => ({
      ...chunk,
      sourceRevision: source.revision,
    })),
  };
}

/** Resolve an output path and reject unsafe or source-overlapping destinations. */
export async function prepareDocumentationOutputDirectory(
  configuredPath: string,
  protectedInputRoot?: string,
): Promise<string> {
  const requestedPath = resolve(configuredPath);
  if (protectedInputRoot && pathsOverlap(protectedInputRoot, requestedPath)) {
    throw new Error(
      'The output directory must not contain or be inside the input directory',
    );
  }

  const parent = dirname(requestedPath);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const outputDirectory = resolve(realParent, basename(requestedPath));
  if (protectedInputRoot && pathsOverlap(protectedInputRoot, outputDirectory)) {
    throw new Error(
      'The output directory must not contain or be inside the input directory',
    );
  }

  try {
    const existing = await lstat(outputDirectory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(
        `Output path must be a directory and cannot be a symbolic link: "${outputDirectory}"`,
      );
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return outputDirectory;
    throw error;
  }
  return outputDirectory;
}

/** Replace an output directory and restore its previous contents on failure. */
export async function promoteDocumentationOutput(
  stagingDirectory: string,
  outputDirectory: string,
): Promise<string | undefined> {
  let backupDirectory: string | undefined;
  try {
    await lstat(outputDirectory);
    backupDirectory = join(
      dirname(outputDirectory),
      `.${basename(outputDirectory)}.backup-${randomUUID()}`,
    );
    await rename(outputDirectory, backupDirectory);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }

  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    if (backupDirectory) {
      try {
        await rename(backupDirectory, outputDirectory);
        backupDirectory = undefined;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Unable to promote the validated build or restore previous output. Previous output remains at "${backupDirectory}"`,
          { cause: restoreError },
        );
      }
    }
    throw new Error(
      `Unable to promote the validated documentation build to "${outputDirectory}"`,
      { cause: error },
    );
  }

  if (backupDirectory) {
    try {
      await rm(backupDirectory, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Unable to remove previous build backup "${backupDirectory}": ${reason}`;
    }
  }
  return undefined;
}

function pathsOverlap(root: string, candidate: string): boolean {
  return isWithin(root, candidate) || isWithin(candidate, root);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error(`Unable to hash binary index file "${path}"`);
    }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}
