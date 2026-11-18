import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { jest } from '@jest/globals';
import {
  searchCatalogDocumentation,
  searchCatalogDocumentationWithSemantic,
  type SearchableCatalogRuntime,
} from '../../../../src/apps/nekosearch/serve.js';

type SearchFunction = SearchableCatalogRuntime['documentation']['search'];

describe('searchCatalogDocumentation', () => {
  it('queries only requested selectors and preserves each index ranking in grouped results', () => {
    const nestResults = [searchHit('nest-first'), searchHit('nest-second')];
    const fastApiResults = [
      searchHit('fastapi-first'),
      searchHit('fastapi-second'),
    ];
    const nestSearch = jest.fn<SearchFunction>(() => nestResults);
    const fastApiSearch = jest.fn<SearchFunction>(() => fastApiResults);
    const runtimes = new Map<string, SearchableCatalogRuntime>([
      ['nestjs@12', runtime('nestjs', '12', nestSearch)],
      ['fastapi@1', runtime('fastapi', '1', fastApiSearch)],
    ]);

    const nestOnly = searchCatalogDocumentation(runtimes, {
      query: 'dependency injection',
      sources: ['nestjs@12'],
    });

    expect(nestSearch).toHaveBeenCalledWith('dependency injection', 10);
    expect(fastApiSearch).not.toHaveBeenCalled();
    expect(nestOnly.structuredContent).toMatchObject({
      totalResults: 2,
      groups: [
        {
          selector: 'nestjs@12',
          results: [
            { documentId: 'nest-first' },
            { documentId: 'nest-second' },
          ],
        },
      ],
    });
  });

  it('validates every selector before searching any source', () => {
    const nestSearch = jest.fn<SearchFunction>(() => [searchHit('nest-first')]);
    const fastApiSearch = jest.fn<SearchFunction>(() => [
      searchHit('fastapi-first'),
    ]);
    const runtimes = new Map<string, SearchableCatalogRuntime>([
      ['nestjs@12', runtime('nestjs', '12', nestSearch)],
      ['fastapi@1', runtime('fastapi', '1', fastApiSearch)],
    ]);

    expect(() =>
      searchCatalogDocumentation(runtimes, {
        query: 'dependency injection',
        sources: ['nestjs@12', 'fastapi@2'],
      }),
    ).toThrow(/Unknown documentation selector.*fastapi@2.*list_docs/u);
    expect(nestSearch).not.toHaveBeenCalled();
    expect(fastApiSearch).not.toHaveBeenCalled();
  });

  it('caps the combined results while retaining per-source order', () => {
    const nestSearch = jest.fn<SearchFunction>(() => [
      searchHit('nest-first'),
      searchHit('nest-second'),
    ]);
    const fastApiSearch = jest.fn<SearchFunction>(() => [
      searchHit('fastapi-first'),
      searchHit('fastapi-second'),
    ]);
    const runtimes = new Map<string, SearchableCatalogRuntime>([
      ['nestjs@12', runtime('nestjs', '12', nestSearch)],
      ['fastapi@1', runtime('fastapi', '1', fastApiSearch)],
    ]);

    const combined = searchCatalogDocumentation(runtimes, {
      query: 'shared topic',
      sources: ['nestjs@12', 'fastapi@1'],
      limit: 3,
    });

    expect(combined.structuredContent.totalResults).toBe(3);
    expect(
      combined.structuredContent.groups.map((group) =>
        group.results.map((result) => result.documentId),
      ),
    ).toEqual([['nest-first', 'nest-second'], ['fastapi-first']]);
    expect(nestSearch).toHaveBeenCalledWith('shared topic', 3);
    expect(fastApiSearch).toHaveBeenCalledWith('shared topic', 3);
  });

  it('embeds the query once, fuses within each selected source, and keeps lexical identifiers', async () => {
    const queryVector = new Float32Array(1024);
    queryVector[0] = 1;
    const nestLexical = jest.fn<SearchFunction>(() => [
      searchHit('nestjs-exact-Identifier'),
    ]);
    const fastApiLexical = jest.fn<SearchFunction>(() => [
      searchHit('fastapi-exact-Identifier'),
    ]);
    const nestSemantic = jest.fn<SemanticSearchFunction>(() => [
      searchHit('nestjs-semantic'),
      searchHit('nestjs-exact-Identifier'),
    ]);
    const fastApiSemantic = jest.fn<SemanticSearchFunction>(() => [
      searchHit('fastapi-semantic'),
      searchHit('fastapi-exact-Identifier'),
    ]);
    const oldNestLexical = jest.fn<SearchFunction>(() => [
      searchHit('nestjs-v11-Identifier'),
    ]);
    const oldNestSemantic = jest.fn<SemanticSearchFunction>(() => [
      searchHit('nestjs-v11-semantic'),
    ]);
    const runtimes = new Map<string, SearchableCatalogRuntime>([
      ['nestjs@12', runtime('nestjs', '12', nestLexical, nestSemantic)],
      ['fastapi@1', runtime('fastapi', '1', fastApiLexical, fastApiSemantic)],
      ['nestjs@11', runtime('nestjs', '11', oldNestLexical, oldNestSemantic)],
    ]);
    const embedQuery = jest.fn(() => Promise.resolve(queryVector));

    const result = await searchCatalogDocumentationWithSemantic(
      runtimes,
      {
        query: 'How can request scoped dependencies be resolved?',
        sources: ['nestjs@12', 'fastapi@1'],
        limit: 4,
      },
      {
        embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
        embedQuery,
      },
    );

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(nestLexical).toHaveBeenCalledWith(
      'How can request scoped dependencies be resolved?',
      50,
    );
    expect(fastApiLexical).toHaveBeenCalledWith(
      'How can request scoped dependencies be resolved?',
      50,
    );
    expect(nestSemantic).toHaveBeenCalledWith(queryVector, 50);
    expect(fastApiSemantic).toHaveBeenCalledWith(queryVector, 50);
    expect(nestSemantic.mock.calls[0]?.[0]).toBe(queryVector);
    expect(fastApiSemantic.mock.calls[0]?.[0]).toBe(queryVector);
    expect(oldNestLexical).not.toHaveBeenCalled();
    expect(oldNestSemantic).not.toHaveBeenCalled();
    const [nestjsGroup, fastApiGroup] = result.structuredContent.groups;
    expect(nestjsGroup?.selector).toBe('nestjs@12');
    expect(nestjsGroup?.results.map(({ chunkId }) => chunkId)).toEqual([
      'nestjs-exact-Identifier-section',
      'nestjs-semantic-section',
    ]);
    expect(fastApiGroup?.selector).toBe('fastapi@1');
    expect(fastApiGroup?.results.map(({ chunkId }) => chunkId)).toEqual([
      'fastapi-exact-Identifier-section',
      'fastapi-semantic-section',
    ]);
  });

  it('rejects selected snapshots without compatible vectors before embedding the query', async () => {
    const lexical = jest.fn<SearchFunction>(() => [searchHit('lexical')]);
    const embedQuery = jest.fn(() => Promise.resolve(new Float32Array(1024)));
    const runtimes = new Map([['nestjs@12', runtime('nestjs', '12', lexical)]]);

    await expect(
      searchCatalogDocumentationWithSemantic(
        runtimes,
        { query: 'request lifecycle', sources: ['nestjs@12'] },
        {
          embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
          embedQuery,
        },
      ),
    ).rejects.toThrow(/embeddings for every selected source/u);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(lexical).not.toHaveBeenCalled();
  });

  it('keeps the bundled protocol snapshot lexical when hybrid search is enabled', async () => {
    const lexical = jest.fn<SearchFunction>(() => [searchHit('mcp-protocol')]);
    const bundled = runtime('mcp', '2025-11-25', lexical);
    bundled.entry.status = 'bundled';
    const embedQuery = jest.fn(() => {
      const vector = new Float32Array(1024);
      vector[0] = 1;
      return Promise.resolve(vector);
    });

    const result = await searchCatalogDocumentationWithSemantic(
      new Map([['mcp@2025-11-25', bundled]]),
      { query: 'tools', sources: ['mcp@2025-11-25'] },
      {
        embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
        embedQuery,
      },
    );

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(lexical).toHaveBeenCalledWith('tools', 50);
    expect(result.structuredContent.groups[0]?.results[0]?.chunkId).toBe(
      'mcp-protocol-section',
    );
  });
});

function runtime(
  source: string,
  version: string,
  search: jest.Mock<SearchFunction>,
  semanticSearch?: jest.Mock<SemanticSearchFunction>,
): SearchableCatalogRuntime {
  return {
    entry: {
      source,
      version,
      revision: `${source}-revision`,
    },
    documentation: { search },
    ...(semanticSearch && {
      semanticRetriever: {
        embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
        search: semanticSearch,
      },
    }),
  };
}

type SemanticSearchFunction = NonNullable<
  SearchableCatalogRuntime['semanticRetriever']
>['search'];

function searchHit(documentId: string): DocumentationSearchResult {
  return {
    chunkId: `${documentId}-section`,
    documentId,
    title: documentId,
    canonicalUrl: `https://docs.example/${documentId}`,
    sourceRevision: `${documentId}-revision`,
    excerpt: `Excerpt for ${documentId}`,
    score: 1,
  };
}
