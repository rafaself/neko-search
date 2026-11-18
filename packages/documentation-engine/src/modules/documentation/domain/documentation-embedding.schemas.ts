import { z } from 'zod';

/**
 * Versioned definition of the only embedding space currently supported by
 * NekoSearch snapshots. Bump the instruction or pipeline version whenever
 * query formatting, tokenization, pooling, or vector output changes.
 */
export const QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 = {
  modelId: 'qwen3-embedding-0.6b',
  modelRevision: 'c25a394dd583836952667c12f008335071b3f43d',
  modelArtifactSha256:
    '87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f',
  embeddingDimensions: 1024,
  dataType: 'float32',
  pooling: 'last_token',
  normalization: 'l2',
  queryInstructionVersion: 'qwen3-software-docs-v1',
  embeddingPipelineVersion: 'nekosearch-qwen3-embedding-v1',
} as const;

export const DocumentationEmbeddingSpaceSchema = z.strictObject({
  modelId: z.literal(QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelId),
  modelRevision: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelRevision,
  ),
  modelArtifactSha256: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelArtifactSha256,
  ),
  embeddingDimensions: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.embeddingDimensions,
  ),
  dataType: z.literal(QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.dataType),
  pooling: z.literal(QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.pooling),
  normalization: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.normalization,
  ),
  queryInstructionVersion: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.queryInstructionVersion,
  ),
  embeddingPipelineVersion: z.literal(
    QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.embeddingPipelineVersion,
  ),
});

export type DocumentationEmbeddingSpace = z.infer<
  typeof DocumentationEmbeddingSpaceSchema
>;

export interface DocumentationEmbeddingVector {
  chunkId: string;
  vector: Float32Array;
}

export interface DocumentationEmbeddingSet {
  embeddingSpace: DocumentationEmbeddingSpace;
  vectors: readonly DocumentationEmbeddingVector[];
}

/** Local provider used only when semantic indexing is explicitly enabled. */
export interface DocumentationEmbeddingProvider {
  embeddingSpace: DocumentationEmbeddingSpace;
  embedDocuments(documents: string[]): Promise<Float32Array[]>;
}
