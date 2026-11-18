import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import type { ModelStatus } from '../../../../src/apps/nekosearch/model-manager.js';
import {
  buildDocumentationEmbeddings,
  formatDocumentationEmbeddingStatuses,
  getDocumentationEmbeddingStatuses,
} from '../../../../src/apps/nekosearch/embeddings.js';
import {
  addSnapshot,
  getCatalogIndex,
} from '../../../../src/apps/nekosearch/catalog.js';
import { createDocumentationTestIndex } from '../../../fixtures/documentation-index.js';

const packageDataDirectory = resolve(process.cwd(), 'data');

describe('NekoSearch existing-snapshot embeddings', () => {
  let root: string;
  let catalogRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-embeddings-'));
    catalogRoot = join(root, 'catalog');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('builds one source or all sources from persisted chunks and reuses completed vectors', async () => {
    await addLexicalSnapshot('nestjs', '12', 'a'.repeat(40));
    await addLexicalSnapshot('fastapi', '1', 'b'.repeat(40));
    const embeddedTexts: string[] = [];
    const provider = makeProvider((texts) => embeddedTexts.push(...texts));

    const specific = await buildDocumentationEmbeddings('fastapi@1', {
      catalogRoot,
      packageDataDirectory,
      embeddingProvider: provider,
    });
    expect(specific).toEqual([
      expect.objectContaining({
        selector: 'fastapi@1',
        totalChunks: 2,
        generatedChunks: 2,
        reusedChunks: 0,
        changed: true,
      }),
    ]);
    expect(embeddedTexts).toHaveLength(2);

    const statuses = await getDocumentationEmbeddingStatuses(undefined, {
      catalogRoot,
      packageDataDirectory,
    });
    expect(statuses).toEqual([
      expect.objectContaining({
        selector: 'fastapi@1',
        modelCompatibility: 'compatible',
        totalChunks: 2,
        embeddedChunks: 2,
        missingEmbeddings: 0,
        invalidEmbeddings: 0,
        completionPercent: 100,
      }),
      expect.objectContaining({
        selector: 'nestjs@12',
        modelCompatibility: 'not built',
        totalChunks: 2,
        embeddedChunks: 0,
        missingEmbeddings: 2,
        invalidEmbeddings: 0,
        completionPercent: 0,
      }),
    ]);
    expect(formatDocumentationEmbeddingStatuses(statuses)).toContain(
      'fastapi@1\tcompatible\t2\t2\t0\t0\t100%',
    );

    const full = await buildDocumentationEmbeddings(undefined, {
      catalogRoot,
      packageDataDirectory,
      embeddingProvider: provider,
    });
    expect(full).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: 'fastapi@1',
          generatedChunks: 0,
          reusedChunks: 2,
          changed: false,
        }),
        expect.objectContaining({
          selector: 'nestjs@12',
          generatedChunks: 2,
          reusedChunks: 0,
          changed: true,
        }),
      ]),
    );
    expect(embeddedTexts).toHaveLength(4);

    const secondFullBuild = await buildDocumentationEmbeddings(undefined, {
      catalogRoot,
      packageDataDirectory,
      embeddingProvider: provider,
    });
    expect(secondFullBuild.every((result) => !result.changed)).toBe(true);
    expect(secondFullBuild.every((result) => result.reusedChunks === 2)).toBe(
      true,
    );
    expect(embeddedTexts).toHaveLength(4);

    const installed = await getCatalogIndex('fastapi@1', {
      catalogRoot,
      packageDataDirectory,
    });
    if (!installed) throw new Error('Built snapshot was not installed');
    const database = new DatabaseSync(installed.databasePath, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT chunk_id FROM documentation_search
             WHERE documentation_search MATCH ? AND documentation_version = ?`,
          )
          .get('ExecutionContext', '1')?.chunk_id,
      ).toBeDefined();
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM documentation_embeddings')
          .get()?.count,
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  it('keeps the active lexical snapshot when generation is interrupted', async () => {
    await addLexicalSnapshot('nestjs', '12', 'c'.repeat(40));
    const controller = new AbortController();
    const provider = makeProvider(() => undefined);

    await expect(
      buildDocumentationEmbeddings('nestjs@12', {
        catalogRoot,
        packageDataDirectory,
        embeddingProvider: provider,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'embedding')
            controller.abort('test interrupt');
        },
      }),
    ).rejects.toThrow(/interrupted before snapshot activation/iu);

    const active = await getCatalogIndex('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(active?.manifest.embeddings).toBeUndefined();
    const statuses = await getDocumentationEmbeddingStatuses('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(statuses[0]).toMatchObject({
      embeddedChunks: 0,
      missingEmbeddings: 2,
      invalidEmbeddings: 0,
    });
  });

  it('reports damaged vectors and snapshot checksum drift in status', async () => {
    await addLexicalSnapshot('nestjs', '12', 'e'.repeat(40));
    await buildDocumentationEmbeddings('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
      embeddingProvider: makeProvider(() => undefined),
    });
    const installed = await getCatalogIndex('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
    });
    if (!installed) throw new Error('Built snapshot was not installed');
    const database = new DatabaseSync(installed.databasePath);
    try {
      database
        .prepare("UPDATE documentation_embeddings SET embedding = X'00'")
        .run();
    } finally {
      database.close();
    }

    const statuses = await getDocumentationEmbeddingStatuses('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(statuses[0]).toMatchObject({
      selector: 'nestjs@12',
      modelCompatibility: 'compatible',
      totalChunks: 2,
      embeddedChunks: 0,
      missingEmbeddings: 2,
      invalidEmbeddings: 2,
      completionPercent: 0,
      snapshotIntegrity: 'invalid',
    });
  });

  it('requires an installed verified model before generating any vectors', async () => {
    await addLexicalSnapshot('nestjs', '12', 'd'.repeat(40));
    let modelChecks = 0;

    await expect(
      buildDocumentationEmbeddings('nestjs@12', {
        catalogRoot,
        packageDataDirectory,
        modelStatusReader: () => {
          modelChecks += 1;
          return Promise.resolve(modelStatus('not-installed'));
        },
      }),
    ).rejects.toThrow(/nekosearch model install/u);
    expect(modelChecks).toBe(1);
  });

  async function addLexicalSnapshot(
    source: string,
    version: string,
    revision: string,
  ): Promise<void> {
    const snapshotDirectory = join(root, `${source}-${version}`);
    mkdirSync(snapshotDirectory);
    createDocumentationTestIndex(
      join(snapshotDirectory, 'index.sqlite'),
      version,
      { documentationId: source, revision },
    );
    const manifestPath = join(snapshotDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      documentation: { id: string };
    };
    manifest.documentation.id = source;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await addSnapshot(snapshotDirectory, {
      catalogRoot,
      packageDataDirectory,
    });
  }
});

function makeProvider(
  onEmbed: (texts: string[]) => void,
): DocumentationEmbeddingProvider {
  return {
    embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    embedDocuments: (texts) => {
      onEmbed(texts);
      return Promise.resolve(
        texts.map(() => {
          const vector = new Float32Array(1024);
          vector[0] = 1;
          return vector;
        }),
      );
    },
  };
}

function modelStatus(
  installationState: ModelStatus['installationState'],
): ModelStatus {
  return {
    modelId: 'qwen3-embedding-0.6b',
    installationState,
    version: '1.0.0',
    upstreamRevision: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelRevision,
    modelDirectory: '/tmp/nekosearch-model',
    artifactIntegrity: installationState === 'installed' ? 'valid' : 'missing',
    runtimeAvailable: false,
    inferenceAvailable: false,
    runtimeRequirement: 'test runtime',
    details: [],
    unmanagedFiles: [],
  };
}
