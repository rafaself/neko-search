import {
  DocumentationEmbeddingSpaceSchema,
  QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';

describe('documentation embedding metadata', () => {
  it('accepts the versioned Qwen3 embedding space', () => {
    expect(
      DocumentationEmbeddingSpaceSchema.parse(
        QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
      ),
    ).toEqual(QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1);
  });

  it.each([
    ['model revision', { modelRevision: 'f'.repeat(40) }],
    ['model artifact checksum', { modelArtifactSha256: '0'.repeat(64) }],
    ['embedding dimensions', { embeddingDimensions: 768 }],
    ['data type', { dataType: 'float16' }],
    ['pooling strategy', { pooling: 'mean' }],
    ['normalization strategy', { normalization: 'none' }],
    ['query instruction version', { queryInstructionVersion: 'v2' }],
    ['pipeline version', { embeddingPipelineVersion: 'v2' }],
  ])('rejects an incompatible %s', (_field, override) => {
    expect(
      DocumentationEmbeddingSpaceSchema.safeParse({
        ...QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
        ...override,
      }).success,
    ).toBe(false);
  });

  it('rejects unversioned extra metadata', () => {
    expect(
      DocumentationEmbeddingSpaceSchema.safeParse({
        ...QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
