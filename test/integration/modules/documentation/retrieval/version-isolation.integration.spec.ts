import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import { createTestIndexManifest } from '../../../../fixtures/documentation-index.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';

describe('documentation version isolation', () => {
  let directory: string;
  let store11: SQLiteDocumentationStore;
  let store12: SQLiteDocumentationStore;
  let service11: DocumentationSearchService;
  let service12: DocumentationSearchService;
  let corpus11: ReturnType<typeof createVersionCorpus>;
  let corpus12: ReturnType<typeof createVersionCorpus>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nestjs-docs-version-'));
    const databasePath11 = join(directory, 'v11.sqlite');
    const databasePath12 = join(directory, 'v12.sqlite');
    corpus11 = createVersionCorpus('11', 'v11onlymango');
    corpus12 = createVersionCorpus('12', 'v12onlygrapefruit');

    const writer11 = new DocumentationIndexWriter(databasePath11, '11');
    const writer12 = new DocumentationIndexWriter(databasePath12, '12');
    writer11.indexCorpus(corpus11);
    writer12.indexCorpus(corpus12);
    writer11.close();
    writer12.close();

    const manifest11 = createTestIndexManifest(databasePath11, corpus11);
    const manifest12 = createTestIndexManifest(databasePath12, corpus12);
    store11 = new SQLiteDocumentationStore(databasePath11, manifest11);
    store12 = new SQLiteDocumentationStore(databasePath12, manifest12);
    service11 = new DocumentationSearchService(store11, manifest11);
    service12 = new DocumentationSearchService(store12, manifest12);
  });

  afterAll(async () => {
    store12?.close();
    store11?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('keeps search results isolated in dedicated SQLite files', () => {
    expect(corpus11.source).toMatchObject({
      kind: 'git',
      repository: 'https://github.com/nestjs/docs.nestjs.com',
      ref: '11.0.0',
      revision: 'a'.repeat(40),
    });
    expect(corpus12.source).toMatchObject({
      kind: 'git',
      repository: 'https://github.com/nestjs/docs.nestjs.com',
      ref: 'master',
      revision: 'b'.repeat(40),
    });
    expect(
      service11.search('v11onlymango').map((result) => result.documentId),
    ).toEqual([corpus11.documents[0]?.id]);
    expect(service11.search('v12onlygrapefruit')).toEqual([]);
    expect(
      service12.search('v12onlygrapefruit').map((result) => result.documentId),
    ).toEqual([corpus12.documents[0]?.id]);
    expect(service12.search('v11onlymango')).toEqual([]);
  });

  it('returns no document when an ID is absent from the selected version', () => {
    const id11 = corpus11.documents[0]!.id;
    const id12 = corpus12.documents[0]!.id;

    expect(service11.fetchDocument(id11)).not.toBeNull();
    expect(service12.fetchDocument(id12)).not.toBeNull();
    expect(service11.fetchDocument(id12)).toBeNull();
    expect(service12.fetchDocument(id11)).toBeNull();
  });

  it('refuses to index a corpus from another major', () => {
    const writer = new DocumentationIndexWriter(
      join(directory, 'v11.sqlite'),
      '11',
    );
    try {
      expect(() => writer.indexCorpus(corpus12)).toThrow(
        'Documentation corpus must contain documents for version "11"',
      );
    } finally {
      writer.close();
    }
  });
});

function createVersionCorpus(version: '11' | '12', uniqueTerm: string) {
  const revision = version === '11' ? 'a'.repeat(40) : 'b'.repeat(40);
  return ingestNestJsDocuments(
    version,
    [
      {
        path: 'content/fundamentals/execution-context.md',
        canonicalUrl:
          version === '11'
            ? 'https://docs.nestjs.com/v11/fundamentals/execution-context'
            : 'https://docs.nestjs.com/fundamentals/execution-context',
        markdown: `# Versioned execution context\n\n## API\n\n${uniqueTerm} describes this version only.`,
      },
    ],
    revision,
  );
}
