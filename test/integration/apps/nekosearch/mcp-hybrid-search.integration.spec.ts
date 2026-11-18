import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { DocumentationIndexRuntimeManifestSchema } from '@nestjs-docs/documentation-engine/domain/documentation-index-manifest.schemas.js';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { DocumentationSearchService } from '@nestjs-docs/documentation-engine/application/services/documentation-search.service.js';
import { SQLiteDocumentationStore } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/sqlite-documentation-store.js';
import { writeDocumentationEmbeddings } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/documentation-embeddings.js';
import { SemanticRetriever } from '@nestjs-docs/documentation-engine/retrieval/retrievers/semantic-retriever.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from '../../../../src/shared/config/package-metadata.js';
import {
  registerSearchDocsTool,
  type SearchableCatalogRuntime,
  type SemanticQueryEmbeddingProvider,
} from '../../../../src/apps/nekosearch/serve.js';
import type { CatalogSearchDocsOutput } from '../../../../src/apps/nekosearch/catalog-contract.js';
import {
  createDocumentationTestIndex,
  createTestIndexManifest,
} from '../../../fixtures/documentation-index.js';
import { jest } from '@jest/globals';

describe('MCP search retrieval modes', () => {
  it('serves lexical results without a model provider when Semantic Search is disabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nekosearch-mcp-lexical-'));
    const runtime = createRuntime(directory, 'nestjs', '12', false);

    try {
      await withSearchClient(
        new Map([['nestjs@12', runtime]]),
        undefined,
        async (client) => {
          const { tools } = await client.listTools();
          const searchTool = tools.find(({ name }) => name === 'search_docs');
          expect(searchTool).toBeDefined();
          expect(searchTool?.inputSchema.properties).toHaveProperty('query');
          expect(searchTool?.inputSchema.properties).toHaveProperty('sources');
          expect(searchTool?.inputSchema.properties).toHaveProperty('limit');
          expect(searchTool?.inputSchema.properties).not.toHaveProperty(
            'retriever',
          );

          const response = await client.callTool({
            name: 'search_docs',
            arguments: {
              query: 'ExecutionContext',
              sources: ['nestjs@12'],
              limit: 1,
            },
          });

          expect(response.isError).not.toBe(true);
          const result = response.structuredContent as CatalogSearchDocsOutput;
          expect(result.totalResults).toBe(1);
          expect(result.groups).toHaveLength(1);
          expect(result.groups[0]).toMatchObject({
            selector: 'nestjs@12',
            source: 'nestjs',
            version: '12',
            revision: 'nestjs-revision-12',
          });
          expect(result.groups[0]?.results[0]).toMatchObject({
            title: 'Execution context',
            canonicalUrl: 'https://docs.example.test/execution-context#api',
            sourceRevision: 'nestjs-revision-12',
          });
        },
      );
    } finally {
      runtime.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fuses lexical and semantic rankings within selected snapshots with one query embedding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nekosearch-mcp-hybrid-'));
    const version12 = createRuntime(directory, 'nestjs', '12', true);
    const version13 = createRuntime(directory, 'nestjs', '13', true);
    const queryVector = unitVector(1, 0);
    const embedQuery = jest.fn<SemanticQueryEmbeddingProvider['embedQuery']>(
      () => Promise.resolve(queryVector),
    );
    const provider: SemanticQueryEmbeddingProvider = {
      embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      embedQuery,
    };

    try {
      await withSearchClient(
        new Map([
          ['nestjs@12', version12],
          ['nestjs@13', version13],
        ]),
        provider,
        async (client) => {
          const response = await client.callTool({
            name: 'search_docs',
            arguments: {
              query: 'xylophone',
              sources: ['nestjs@12', 'nestjs@13'],
              limit: 2,
            },
          });

          expect(response.isError).not.toBe(true);
          expect(embedQuery).toHaveBeenCalledTimes(1);
          expect(embedQuery).toHaveBeenCalledWith('xylophone');
          const result = response.structuredContent as CatalogSearchDocsOutput;
          expect(result.totalResults).toBe(2);
          expect(result.groups.map(({ selector }) => selector)).toEqual([
            'nestjs@12',
            'nestjs@13',
          ]);
          expect(result.groups[0]?.results[0]?.chunkId).toBe(
            version12.firstChunkId,
          );
          expect(result.groups[1]?.results[0]?.chunkId).toBe(
            version13.firstChunkId,
          );
          const hit = result.groups[0]?.results[0];
          expect(typeof hit?.documentId).toBe('string');
          expect(typeof hit?.title).toBe('string');
          expect(typeof hit?.canonicalUrl).toBe('string');
          expect(hit?.sourceRevision).toBe('nestjs-revision-12');
          expect(typeof hit?.excerpt).toBe('string');
          expect(typeof hit?.score).toBe('number');
        },
      );
    } finally {
      version12.store.close();
      version13.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns an actionable MCP error instead of lexical results when vectors are missing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nekosearch-mcp-no-vectors-'));
    const runtime = createRuntime(directory, 'nestjs', '12', false);
    const lexicalSearch = jest.fn(
      runtime.documentation.search.bind(runtime.documentation),
    );
    runtime.documentation = { search: lexicalSearch };
    const provider: SemanticQueryEmbeddingProvider = {
      embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      embedQuery: jest.fn(() => Promise.resolve(unitVector(1, 0))),
    };

    try {
      await withSearchClient(
        new Map([['nestjs@12', runtime]]),
        provider,
        async (client) => {
          const response = await client.callTool({
            name: 'search_docs',
            arguments: {
              query: 'ExecutionContext',
              sources: ['nestjs@12'],
            },
          });

          expect(response.isError).toBe(true);
          expect(JSON.stringify(response)).toMatch(
            /Semantic Search is enabled.*run nekosearch embeddings build nestjs@12/u,
          );
          expect(lexicalSearch).not.toHaveBeenCalled();
        },
      );
    } finally {
      runtime.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function withSearchClient(
  runtimes: ReadonlyMap<string, SearchableCatalogRuntime>,
  embeddingProvider: SemanticQueryEmbeddingProvider | undefined,
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
  registerSearchDocsTool(server, runtimes, embeddingProvider);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: 'mcp-search-integration',
    version: '1.0.0',
  });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    await action(client);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

function createRuntime(
  directory: string,
  source: string,
  version: string,
  withEmbeddings: boolean,
): SearchableCatalogRuntime & {
  store: SQLiteDocumentationStore;
  firstChunkId: string;
} {
  const databasePath = join(directory, `${source}-${version}.sqlite`);
  const corpus = createDocumentationTestIndex(databasePath, version, {
    revision: `${source}-revision-${version}`,
  });
  const chunks = corpus.documents.flatMap((document) => document.chunks);

  if (withEmbeddings) {
    const database = new DatabaseSync(databasePath);
    try {
      writeDocumentationEmbeddings(
        database,
        chunks.map((chunk, index) => ({
          chunkId: chunk.id,
          vector: index === 0 ? unitVector(1, 0) : unitVector(0, 1),
        })),
      );
    } finally {
      database.close();
    }
  }

  const runtimeManifest = DocumentationIndexRuntimeManifestSchema.parse({
    ...createTestIndexManifest(databasePath, corpus, source),
    ...(withEmbeddings && {
      embeddings: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    }),
  });
  const store = new SQLiteDocumentationStore(databasePath, runtimeManifest);
  const semanticRetriever = withEmbeddings
    ? new SemanticRetriever(
        store,
        runtimeManifest.embeddings!,
        QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      )
    : undefined;
  return {
    entry: { source, version, revision: corpus.source.revision },
    documentation: new DocumentationSearchService(store, runtimeManifest),
    store,
    firstChunkId: chunks[0]!.id,
    ...(semanticRetriever && { semanticRetriever }),
  };
}

function unitVector(first: number, second: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = first;
  vector[1] = second;
  return vector;
}
