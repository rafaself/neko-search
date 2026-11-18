import type { DocumentationSearchResult } from '../../application/contracts/documentation-reader.contract.js';

export const RECIPROCAL_RANK_FUSION_K = 60;
export const LEXICAL_RETRIEVAL_TOP_K = 50;
export const SEMANTIC_RETRIEVAL_TOP_K = 50;

/** Fuse two independent, already ranked result lists from one snapshot. */
export function reciprocalRankFusion(
  lexicalResults: readonly DocumentationSearchResult[],
  semanticResults: readonly DocumentationSearchResult[],
  limit = LEXICAL_RETRIEVAL_TOP_K,
): DocumentationSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('RRF result limit must be a positive integer');
  }

  const fused = new Map<
    string,
    { result: DocumentationSearchResult; score: number }
  >();
  addRankedResults(fused, lexicalResults);
  addRankedResults(fused, semanticResults);

  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareStrings(left.result.chunkId, right.result.chunkId),
    )
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

function addRankedResults(
  fused: Map<string, { result: DocumentationSearchResult; score: number }>,
  results: readonly DocumentationSearchResult[],
): void {
  const seen = new Set<string>();
  for (const [index, result] of results.entries()) {
    if (seen.has(result.chunkId)) continue;
    seen.add(result.chunkId);
    const existing = fused.get(result.chunkId);
    const contribution = 1 / (RECIPROCAL_RANK_FUSION_K + index + 1);
    if (existing) {
      existing.score += contribution;
    } else {
      fused.set(result.chunkId, { result, score: contribution });
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
