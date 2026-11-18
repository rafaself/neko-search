import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDocumentationSnapshot } from '../../../../apps/docs-indexer/src/services/build-documentation-snapshot.js';
import { createNestJsDocumentationIdentity } from '../../../../apps/docs-indexer/src/integrations/nestjs/version/documentation-version.js';
import { transformNestJsDocument } from '../../../../apps/docs-indexer/src/integrations/nestjs/nestjs-documentation-transformer.js';
import {
  ingestNestJsDocuments,
  makeNestJsSnapshot,
} from '../../../fixtures/ingestion.fixtures.js';
import { DocumentationBuildManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import {
  QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
  type DocumentationEmbeddingSet,
  type DocumentationEmbeddingVector,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { validateDocumentationIndex } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-integrity.js';
import { DOCUMENTATION_EMBEDDINGS_TABLE } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/index-schema.js';
import { addSnapshot } from '../../../../src/apps/nekosearch/catalog.js';

describe('hybrid documentation snapshot builds', () => {
  it('validates hybrid output before atomic promotion and keeps lexical-only builds valid', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hybrid-snapshot-build-'));
    const hybridDirectory = join(workspace, 'hybrid');
    const lexicalDirectory = join(workspace, 'lexical');
    const revision = 'b'.repeat(40);
    const documents = [
      {
        path: 'content/guide.md',
        canonicalUrl: 'https://docs.nestjs.com/guide',
        markdown: '# Guide\n\nSnapshot lexicalmarker stays searchable.',
      },
    ];
    const snapshot = makeNestJsSnapshot('12', documents, revision);
    const corpus = ingestNestJsDocuments('12', documents, revision);
    const embeddingSet = embeddingsFor(corpus);
    const request = {
      identity: createNestJsDocumentationIdentity('12', 'content/guide.md'),
      snapshot,
      transformDocument: transformNestJsDocument,
      transformerVersion: 1,
      outputDirectory: hybridDirectory,
      mode: 'clean' as const,
      embeddingSet,
    };

    try {
      await buildDocumentationSnapshot(request);
      const hybridManifest = DocumentationBuildManifestSchema.parse(
        JSON.parse(
          await readFile(join(hybridDirectory, 'manifest.json'), 'utf8'),
        ) as unknown,
      );
      expect(hybridManifest.embeddings).toEqual(embeddingSet.embeddingSpace);
      expect(
        validateDocumentationIndex(
          '12',
          corpus,
          join(hybridDirectory, 'index.sqlite'),
          embeddingSet.embeddingSpace,
        ),
      ).toEqual({ documentCount: 1, chunkCount: 1 });

      const hybridDatabase = new DatabaseSync(
        join(hybridDirectory, 'index.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          hybridDatabase
            .prepare(
              `SELECT COUNT(*) AS count FROM ${DOCUMENTATION_EMBEDDINGS_TABLE}`,
            )
            .get()?.count,
        ).toBe(corpus.documents.flatMap((document) => document.chunks).length);
        expect(
          hybridDatabase
            .prepare(
              `SELECT chunk_id FROM documentation_search
                 WHERE documentation_search MATCH ? AND documentation_version = ?
                 ORDER BY bm25(documentation_search) LIMIT 1`,
            )
            .get('lexicalmarker', '12')?.chunk_id,
        ).toBe(corpus.documents[0]!.chunks[0]!.id);
      } finally {
        hybridDatabase.close();
      }

      const tamperedDirectory = join(workspace, 'tampered-hybrid');
      const catalogRoot = join(workspace, 'catalog');
      await cp(hybridDirectory, tamperedDirectory, { recursive: true });
      const tamperedDatabase = new DatabaseSync(
        join(tamperedDirectory, 'index.sqlite'),
      );
      try {
        tamperedDatabase
          .prepare(
            `DELETE FROM ${DOCUMENTATION_EMBEDDINGS_TABLE} WHERE chunk_id = ?`,
          )
          .run(corpus.documents[0]!.chunks[0]!.id);
      } finally {
        tamperedDatabase.close();
      }
      const tamperedManifest = JSON.parse(
        await readFile(join(tamperedDirectory, 'manifest.json'), 'utf8'),
      ) as { index: { sha256: string } };
      tamperedManifest.index.sha256 = createHash('sha256')
        .update(await readFile(join(tamperedDirectory, 'index.sqlite')))
        .digest('hex');
      await writeFile(
        join(tamperedDirectory, 'manifest.json'),
        `${JSON.stringify(tamperedManifest, null, 2)}\n`,
        'utf8',
      );
      await expect(
        addSnapshot(tamperedDirectory, {
          catalogRoot,
          packageDataDirectory: join(workspace, 'empty-package-data'),
        }),
      ).rejects.toThrow(/embeddings are missing|missing sqlite embedding/iu);
      await expect(readdir(catalogRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const previousOutput = await readSnapshotFiles(hybridDirectory);
      const incompleteSet = {
        ...embeddingSet,
        vectors: embeddingSet.vectors.slice(0, -1),
      };
      await expect(
        buildDocumentationSnapshot({ ...request, embeddingSet: incompleteSet }),
      ).rejects.toThrow(/missing embedding|incomplete/iu);
      expect(await readSnapshotFiles(hybridDirectory)).toEqual(previousOutput);
      expect(
        (await readdir(workspace)).filter((name) => name.includes('.staging-')),
      ).toEqual([]);

      await buildDocumentationSnapshot({
        ...request,
        outputDirectory: lexicalDirectory,
        embeddingSet: undefined,
      });
      const lexicalManifest = DocumentationBuildManifestSchema.parse(
        JSON.parse(
          await readFile(join(lexicalDirectory, 'manifest.json'), 'utf8'),
        ) as unknown,
      );
      expect(lexicalManifest.embeddings).toBeUndefined();
      expect(
        validateDocumentationIndex(
          '12',
          corpus,
          join(lexicalDirectory, 'index.sqlite'),
        ),
      ).toEqual({ documentCount: 1, chunkCount: 1 });

      const lexicalDatabase = new DatabaseSync(
        join(lexicalDirectory, 'index.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          lexicalDatabase
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .get(DOCUMENTATION_EMBEDDINGS_TABLE),
        ).toBeUndefined();
      } finally {
        lexicalDatabase.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function embeddingsFor(
  corpus: ReturnType<typeof ingestNestJsDocuments>,
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

async function readSnapshotFiles(directory: string): Promise<Buffer[]> {
  return Promise.all(
    ['corpus.json', 'index.sqlite', 'manifest.json'].map((filename) =>
      readFile(join(directory, filename)),
    ),
  );
}
