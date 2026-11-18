import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import type {
  DocumentationEmbeddingSet,
  DocumentationEmbeddingVector,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import {
  DOCUMENTATION_EMBEDDINGS_SCHEMA,
  DOCUMENTATION_EMBEDDINGS_TABLE,
} from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { ingestNestJsDocuments } from '../../../../fixtures/ingestion.fixtures.js';

describe('SQLite documentation embeddings', () => {
  it('stores one Float32 BLOB per chunk while preserving FTS5 BM25 search', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'documentation-embeddings-'),
    );
    const databasePath = join(directory, 'index.sqlite');
    const corpus = createCorpus();
    const embeddingSet = embeddingsFor(corpus);
    const writer = new DocumentationIndexWriter(databasePath, '12');
    const database = new DatabaseSync(databasePath);

    try {
      expect(writer.indexCorpus(corpus, embeddingSet)).toBe(1);
      expect(
        validateDocumentationIndex(
          '12',
          corpus,
          databasePath,
          embeddingSet.embeddingSpace,
        ),
      ).toEqual({ documentCount: 1, chunkCount: 1 });

      const tableSql = database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        )
        .get(DOCUMENTATION_EMBEDDINGS_TABLE)?.sql;
      expect(tableSql).toBe(DOCUMENTATION_EMBEDDINGS_SCHEMA);
      expect(
        database
          .prepare(`PRAGMA foreign_key_list(${DOCUMENTATION_EMBEDDINGS_TABLE})`)
          .all(),
      ).toEqual([]);
      expect(
        database
          .prepare(`PRAGMA table_info(${DOCUMENTATION_EMBEDDINGS_TABLE})`)
          .all()
          .map((column) => column.name),
      ).toEqual(['chunk_id', 'embedding']);

      const stored = database
        .prepare(
          `SELECT chunk_id AS chunkId, embedding FROM ${DOCUMENTATION_EMBEDDINGS_TABLE}`,
        )
        .all();
      expect(stored).toHaveLength(corpus.documents[0]!.chunks.length);
      expect(stored[0]?.chunkId).toBe(corpus.documents[0]!.chunks[0]!.id);
      expect((stored[0]?.embedding as Uint8Array).byteLength).toBe(4096);

      const lexicalResult = database
        .prepare(
          `SELECT chunk_id AS chunkId, bm25(documentation_search) AS rank
             FROM documentation_search
             WHERE documentation_search MATCH ? AND documentation_version = ?`,
        )
        .get('lexicalmarker', '12');
      expect(lexicalResult?.chunkId).toBe(corpus.documents[0]!.chunks[0]!.id);
      expect(typeof lexicalResult?.rank).toBe('number');
    } finally {
      database.close();
      writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps lexical-only databases valid without an embedding table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'documentation-lexical-'));
    const databasePath = join(directory, 'index.sqlite');
    const corpus = createCorpus();
    const writer = new DocumentationIndexWriter(databasePath, '12');
    const database = new DatabaseSync(databasePath);

    try {
      writer.indexCorpus(corpus);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
          )
          .get(DOCUMENTATION_EMBEDDINGS_TABLE),
      ).toBeUndefined();
      expect(validateDocumentationIndex('12', corpus, databasePath)).toEqual({
        documentCount: 1,
        chunkCount: 1,
      });
    } finally {
      database.close();
      writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects incomplete, duplicate, orphaned, malformed, or incompatible inputs before indexing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'documentation-invalid-'));
    const databasePath = join(directory, 'index.sqlite');
    const corpus = createCorpus();
    const validSet = embeddingsFor(corpus);
    const vector = validSet.vectors[0]!;
    const invalidSets: Array<{
      set: DocumentationEmbeddingSet;
      error: RegExp;
    }> = [
      {
        set: { ...validSet, vectors: [] },
        error: /missing embedding|incomplete/iu,
      },
      {
        set: { ...validSet, vectors: [vector, vector] },
        error: /duplicate embedding/iu,
      },
      {
        set: {
          ...validSet,
          vectors: [{ ...vector, chunkId: 'not-in-corpus' }],
        },
        error: /nonexistent corpus chunk/iu,
      },
      {
        set: {
          ...validSet,
          vectors: [
            {
              ...vector,
              vector: new Float32Array(1023),
            },
          ],
        },
        error: /1024-dimensional Float32Array/iu,
      },
      {
        set: {
          ...validSet,
          embeddingSpace: {
            ...validSet.embeddingSpace,
            modelRevision: 'f'.repeat(40),
          } as DocumentationEmbeddingSet['embeddingSpace'],
        },
        error: /metadata is incompatible/iu,
      },
    ];
    const writer = new DocumentationIndexWriter(databasePath, '12');

    try {
      writer.indexCorpus(corpus);
      for (const invalid of invalidSets) {
        expect(() => writer.indexCorpus(corpus, invalid.set)).toThrow(
          invalid.error,
        );
      }
      const database = new DatabaseSync(databasePath);
      try {
        expect(
          database
            .prepare('SELECT COUNT(*) AS count FROM documentation_search')
            .get()?.count,
        ).toBe(corpus.documents[0]!.chunks.length);
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .get(DOCUMENTATION_EMBEDDINGS_TABLE),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('detects missing and invalid Float32 BLOB rows before a snapshot is accepted', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'documentation-blob-check-'),
    );
    const databasePath = join(directory, 'index.sqlite');
    const corpus = createCorpus();
    const embeddingSet = embeddingsFor(corpus);
    const writer = new DocumentationIndexWriter(databasePath, '12');
    const database = new DatabaseSync(databasePath);
    const chunkId = corpus.documents[0]!.chunks[0]!.id;

    try {
      writer.indexCorpus(corpus, embeddingSet);
      database
        .prepare(
          `DELETE FROM ${DOCUMENTATION_EMBEDDINGS_TABLE} WHERE chunk_id = ?`,
        )
        .run(chunkId);
      expect(() =>
        validateDocumentationIndex(
          '12',
          corpus,
          databasePath,
          embeddingSet.embeddingSpace,
        ),
      ).toThrow(/embeddings are missing/u);

      writer.indexCorpus(corpus, embeddingSet);
      database
        .prepare(`UPDATE ${DOCUMENTATION_EMBEDDINGS_TABLE} SET embedding = ?`)
        .run(Buffer.alloc(4));
      expect(() =>
        validateDocumentationIndex(
          '12',
          corpus,
          databasePath,
          embeddingSet.embeddingSpace,
        ),
      ).toThrow(/exactly 4096 bytes/u);

      writer.indexCorpus(corpus, embeddingSet);
      database
        .prepare(`UPDATE ${DOCUMENTATION_EMBEDDINGS_TABLE} SET chunk_id = ?`)
        .run('orphaned-chunk');
      expect(() =>
        validateDocumentationIndex(
          '12',
          corpus,
          databasePath,
          embeddingSet.embeddingSpace,
        ),
      ).toThrow(/nonexistent indexed chunk/u);
    } finally {
      database.close();
      writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createCorpus() {
  return ingestNestJsDocuments(
    '12',
    [
      {
        path: 'content/guide.md',
        canonicalUrl: 'https://docs.nestjs.com/guide',
        markdown: '# Guide\n\nThe lexicalmarker remains searchable with BM25.',
      },
    ],
    'a'.repeat(40),
  );
}

function embeddingsFor(
  corpus: ReturnType<typeof createCorpus>,
): DocumentationEmbeddingSet {
  const vectors: DocumentationEmbeddingVector[] = corpus.documents.flatMap(
    (document, documentIndex) =>
      document.chunks.map((chunk, chunkIndex) => {
        const vector = new Float32Array(1024);
        vector[(documentIndex + chunkIndex) % vector.length] = 1;
        return { chunkId: chunk.id, vector };
      }),
  );
  return {
    embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    vectors,
  };
}
