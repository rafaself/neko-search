import type { DocumentationSearchResult } from '@nestjs-docs/documentation-engine/application/contracts/documentation-reader.contract.js';
import { reciprocalRankFusion } from '@nestjs-docs/documentation-engine/retrieval/fusion/reciprocal-rank-fusion.js';

describe('reciprocalRankFusion', () => {
  it('adds reciprocal rank contributions from both lists and breaks ties by chunk ID', () => {
    const lexical = [searchResult('z-lexical'), searchResult('shared')];
    const semantic = [searchResult('a-semantic'), searchResult('shared')];

    const fused = reciprocalRankFusion(lexical, semantic);

    expect(fused.map(({ chunkId }) => chunkId)).toEqual([
      'shared',
      'a-semantic',
      'z-lexical',
    ]);
    expect(fused[0]?.score).toBeCloseTo(2 / 61);
    expect(fused[1]?.score).toBeCloseTo(1 / 61);
    expect(fused[2]?.score).toBeCloseTo(1 / 61);
  });

  it('returns unique results within the requested limit deterministically', () => {
    const lexical = [
      searchResult('chunk-c'),
      searchResult('chunk-b'),
      searchResult('chunk-a'),
    ];
    const semantic = [
      searchResult('chunk-a'),
      searchResult('chunk-b'),
      searchResult('chunk-c'),
    ];

    expect(
      reciprocalRankFusion(lexical, semantic, 2).map(({ chunkId }) => chunkId),
    ).toEqual(['chunk-a', 'chunk-c']);
  });

  it('rejects an invalid result limit', () => {
    expect(() => reciprocalRankFusion([], [], 0)).toThrow(/positive integer/u);
  });
});

function searchResult(chunkId: string): DocumentationSearchResult {
  return {
    chunkId,
    documentId: `document-${chunkId}`,
    title: chunkId,
    canonicalUrl: `https://docs.example/${chunkId}`,
    sourceRevision: 'test-revision',
    excerpt: chunkId,
    score: 1,
  };
}
