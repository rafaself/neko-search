import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { jest } from '@jest/globals';
import {
  searchCatalogDocumentation,
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
});

function runtime(
  source: string,
  version: string,
  search: jest.Mock<SearchFunction>,
): SearchableCatalogRuntime {
  return {
    entry: {
      source,
      version,
      revision: `${source}-revision`,
    },
    documentation: { search },
  };
}

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
