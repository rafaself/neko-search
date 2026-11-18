import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1 } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import type { ModelStatus } from '../../../../src/apps/nekosearch/model-manager.js';
import {
  loadSemanticSearchConfiguration,
  resolveConfiguredEmbeddingProvider,
} from '../../../../src/apps/nekosearch/semantic-search.js';

describe('semantic search ingestion configuration', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nekosearch-semantic-config-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('defaults to lexical-only when no configuration file exists', async () => {
    await expect(
      loadSemanticSearchConfiguration({ cwd: directory, environment: {} }),
    ).resolves.toMatchObject({
      enabled: false,
      configPath: join(directory, 'nekosearch.yaml'),
    });
  });

  it('reads the requested YAML shape and honors NEKOSEARCH_CONFIG', async () => {
    const configPath = join(directory, 'custom.yaml');
    await writeFile(
      configPath,
      'search:\n  semantic:\n    enabled: true\n',
      'utf8',
    );

    await expect(
      loadSemanticSearchConfiguration({
        cwd: directory,
        environment: { NEKOSEARCH_CONFIG: configPath },
      }),
    ).resolves.toMatchObject({ enabled: true, configPath });
  });

  it('rejects malformed YAML and unknown configuration keys', async () => {
    const configPath = join(directory, 'nekosearch.yaml');
    await writeFile(
      configPath,
      'search:\n  semantic:\n    enabled: yes\n',
      'utf8',
    );
    await expect(
      loadSemanticSearchConfiguration({ cwd: directory, environment: {} }),
    ).rejects.toThrow(/search\.semantic\.enabled/iu);

    await writeFile(
      configPath,
      'search:\n  semantic:\n    enabled: true\n    typo: true\n',
      'utf8',
    );
    await expect(
      loadSemanticSearchConfiguration({ cwd: directory, environment: {} }),
    ).rejects.toThrow(/Unrecognized key: "typo"/iu);
  });

  it('does not inspect the model or construct a generator when disabled', async () => {
    const modelStatusReader = jest.fn(() =>
      Promise.resolve(modelStatus('not-installed')),
    );
    const embeddingProviderFactory = jest.fn(() =>
      Promise.resolve(makeProvider()),
    );

    await expect(
      resolveConfiguredEmbeddingProvider({
        cwd: directory,
        environment: {},
        modelStatusReader,
        embeddingProviderFactory,
      }),
    ).resolves.toBeUndefined();
    expect(modelStatusReader).not.toHaveBeenCalled();
    expect(embeddingProviderFactory).not.toHaveBeenCalled();
  });

  it('reports the explicit install action when enabled but Qwen is missing', async () => {
    await writeEnabledConfig();
    const embeddingProviderFactory = jest.fn(() =>
      Promise.resolve(makeProvider()),
    );

    await expect(
      resolveConfiguredEmbeddingProvider({
        cwd: directory,
        environment: {},
        modelStatusReader: () => Promise.resolve(modelStatus('not-installed')),
        embeddingProviderFactory,
      }),
    ).rejects.toThrow(/nekosearch model install.*never downloads/iu);
    expect(embeddingProviderFactory).not.toHaveBeenCalled();
  });

  it('resolves the local provider only after the installed model is verified', async () => {
    await writeEnabledConfig();
    const expectedProvider = makeProvider();
    const embeddingProviderFactory = jest.fn(() =>
      Promise.resolve(expectedProvider),
    );
    const modelStatusReader = jest.fn(() =>
      Promise.resolve(modelStatus('installed')),
    );

    await expect(
      resolveConfiguredEmbeddingProvider({
        cwd: directory,
        environment: {},
        modelStatusReader,
        embeddingProviderFactory,
      }),
    ).resolves.toBe(expectedProvider);
    expect(modelStatusReader).toHaveBeenCalledTimes(1);
    expect(embeddingProviderFactory).toHaveBeenCalledTimes(1);
  });

  it('requires a compatible inference runtime before building snapshots', async () => {
    await writeEnabledConfig();
    const embeddingProviderFactory = jest.fn(() =>
      Promise.resolve(makeProvider()),
    );

    await expect(
      resolveConfiguredEmbeddingProvider({
        cwd: directory,
        environment: {},
        modelStatusReader: () =>
          Promise.resolve(modelStatus('installed', false)),
        embeddingProviderFactory,
      }),
    ).rejects.toThrow(/optional @huggingface\/transformers@4\.3\.2/iu);
    expect(embeddingProviderFactory).not.toHaveBeenCalled();
  });

  async function writeEnabledConfig(): Promise<void> {
    await writeFile(
      join(directory, 'nekosearch.yaml'),
      'search:\n  semantic:\n    enabled: true\n',
      'utf8',
    );
  }
});

function makeProvider(): DocumentationEmbeddingProvider {
  return {
    embeddingSpace: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
    embedDocuments: () => Promise.resolve([]),
  };
}

function modelStatus(
  installationState: ModelStatus['installationState'],
  inferenceAvailable = installationState === 'installed',
): ModelStatus {
  return {
    modelId: 'qwen3-embedding-0.6b',
    installationState,
    version: '1.0.0',
    upstreamRevision: QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelRevision,
    modelDirectory: '/tmp/nekosearch-model',
    artifactIntegrity: installationState === 'installed' ? 'valid' : 'missing',
    runtimeAvailable: inferenceAvailable,
    inferenceAvailable,
    runtimeRequirement: 'test runtime',
    details: [],
    unmanagedFiles: [],
  };
}
