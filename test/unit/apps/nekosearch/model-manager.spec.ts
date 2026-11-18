import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  formatModelStatus,
  getModelStatus,
  installModel,
  removeModel,
  resolveModelDirectory,
  type ModelManagerOptions,
  type ModelRelease,
} from '../../../../src/apps/nekosearch/model-manager.js';

const MODEL_ID = 'qwen3-embedding-0.6b';
const MODEL_VERSION = '1.0.0';
const UPSTREAM_REVISION = 'c25a394dd583836952667c12f008335071b3f43d';
const ARTIFACTS = [
  ['config.json', Buffer.from('{"model":"qwen3"}')],
  ['tokenizer.json', Buffer.from('{"type":"bpe"}')],
  ['tokenizer_config.json', Buffer.from('{"padding_side":"left"}')],
  ['model_quantized.onnx', Buffer.from('small onnx fixture')],
  ['Apache-2.0.txt', Buffer.from('Apache license fixture')],
  ['NOTICE', Buffer.from('Qwen and ONNX Community')],
] as const;
const INFERENCE_FILES = new Set([
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'model_quantized.onnx',
]);

describe('local model manager', () => {
  let temporaryDirectory: string;
  let modelDirectory: string;
  let release: ModelRelease;
  let files: Map<string, Buffer>;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'nekosearch-model-test-'),
    );
    modelDirectory = join(temporaryDirectory, 'model', MODEL_ID, MODEL_VERSION);
    ({ files, release } = createReleaseFixture());
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('respects the process model-directory override and explicit directory priority', () => {
    const previousOverride = process.env.NEKOSEARCH_MODEL_DIR;
    process.env.NEKOSEARCH_MODEL_DIR = join(temporaryDirectory, 'environment');
    try {
      expect(resolveModelDirectory()).toBe(
        resolve(temporaryDirectory, 'environment'),
      );
      expect(resolveModelDirectory({ modelDirectory })).toBe(
        resolve(modelDirectory),
      );
      expect(
        resolveModelDirectory({
          modelDirectory,
          environment: { NEKOSEARCH_MODEL_DIR: '/tmp/from-options' },
        }),
      ).toBe(resolve(modelDirectory));
    } finally {
      if (previousOverride === undefined) {
        delete process.env.NEKOSEARCH_MODEL_DIR;
      } else {
        process.env.NEKOSEARCH_MODEL_DIR = previousOverride;
      }
    }
  });

  it('resumes interrupted assets and activates only a complete verified install', async () => {
    const progress: string[] = [];
    let interruptionState = 0;
    let observedStagingState = false;
    const options: ModelManagerOptions = {
      modelDirectory,
      release,
      progress: (message) => progress.push(message),
      fetcher: async (input, init) => {
        const name =
          new URL(requestUrl(input)).pathname.split('/').at(-1) ?? '';
        const status = await getModelStatus({ modelDirectory, release });
        observedStagingState ||= status.installationState === 'not-installed';
        const bytes = files.get(name);
        if (!bytes) throw new Error(`Unexpected release asset ${name}`);
        const range = new Headers(init?.headers).get('range');

        if (name === 'model_quantized.onnx') {
          if (interruptionState === 0 && !range) {
            interruptionState = 1;
            let sentPartial = false;
            const body = new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (sentPartial) {
                    controller.error(new Error('connection interrupted'));
                  } else {
                    sentPartial = true;
                    controller.enqueue(bytes.subarray(0, 5));
                  }
                },
              },
              { highWaterMark: 0 },
            );
            return new Response(body);
          }
          if (interruptionState < 3) {
            interruptionState += 1;
            throw new Error('network unavailable');
          }
          expect(range).toBe('bytes=5-');
          return new Response(bytes.subarray(5), {
            status: 206,
            headers: {
              'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}`,
            },
          });
        }

        return new Response(bytes);
      },
    };

    await expect(installModel(options)).rejects.toThrow('after 3 attempts');
    expect(await getModelStatus(options)).toMatchObject({
      installationState: 'not-installed',
      artifactIntegrity: 'missing',
      inferenceAvailable: false,
    });
    expect(observedStagingState).toBe(true);

    const result = await installModel(options);
    expect(result).toEqual({ modelDirectory, alreadyInstalled: false });
    const status = await getModelStatus(options);
    expect(status).toMatchObject({
      modelId: MODEL_ID,
      installationState: 'installed',
      version: MODEL_VERSION,
      upstreamRevision: UPSTREAM_REVISION,
      artifactIntegrity: 'valid',
    });
    expect(status.inferenceAvailable).toBe(status.runtimeAvailable);
    expect(formatModelStatus(status)).toContain('Artifact integrity: valid');
    expect(
      progress.some((message) => message.includes('model_quantized.onnx')),
    ).toBe(true);
    expect(await installModel(options)).toEqual({
      modelDirectory,
      alreadyInstalled: true,
    });

    await writeFile(join(modelDirectory, 'user-notes.txt'), 'keep this file');
    await writeFile(join(modelDirectory, 'model_quantized.onnx'), 'corrupted');
    expect((await getModelStatus(options)).installationState).toBe('corrupt');

    const removal = await removeModel(options);
    expect(removal.removed).toBe(true);
    expect(removal.preservedFiles).toEqual(['user-notes.txt']);
    expect(await readFile(join(modelDirectory, 'user-notes.txt'), 'utf8')).toBe(
      'keep this file',
    );
    expect(await readdir(modelDirectory)).toEqual(['user-notes.txt']);
    expect((await getModelStatus(options)).installationState).toBe('unmanaged');
  });

  it('refuses to remove or overwrite a directory without the NekoSearch marker', async () => {
    const options: ModelManagerOptions = { modelDirectory, release };
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, 'user-model.onnx'), 'user-owned');

    await expect(installModel(options)).rejects.toThrow(
      'unmanaged model directory',
    );
    await expect(removeModel(options)).rejects.toThrow(
      'unmanaged model directory',
    );
    expect(
      await readFile(join(modelDirectory, 'user-model.onnx'), 'utf8'),
    ).toBe('user-owned');
  });

  it('blocks model removal while Semantic Search is enabled', async () => {
    const options: ModelManagerOptions = {
      modelDirectory,
      release,
      fetcher: (input) => {
        const name =
          new URL(requestUrl(input)).pathname.split('/').at(-1) ?? '';
        const bytes = files.get(name);
        if (!bytes) throw new Error(`Unexpected release asset ${name}`);
        return Promise.resolve(new Response(bytes));
      },
      progress: () => undefined,
    };
    await installModel(options);
    const configPath = join(temporaryDirectory, 'nekosearch.yaml');
    await writeFile(
      configPath,
      'search:\n  semantic:\n    enabled: true\n',
      'utf8',
    );

    await expect(
      removeModel({
        modelDirectory,
        release,
        environment: { NEKOSEARCH_CONFIG: configPath },
      }),
    ).rejects.toThrow(/nekosearch embeddings disable/iu);
    expect((await getModelStatus(options)).installationState).toBe('installed');
  });

  it('does not activate files whose downloaded checksum differs from the manifest', async () => {
    const corruptedFiles = new Map(files);
    corruptedFiles.set('tokenizer.json', Buffer.from('wrong checksum'));
    const options: ModelManagerOptions = {
      modelDirectory,
      release,
      fetcher: (input) => {
        const name =
          new URL(requestUrl(input)).pathname.split('/').at(-1) ?? '';
        const bytes = corruptedFiles.get(name);
        if (!bytes) throw new Error(`Unexpected release asset ${name}`);
        return Promise.resolve(new Response(bytes));
      },
      progress: () => undefined,
    };

    await expect(installModel(options)).rejects.toThrow(
      'Integrity check failed for tokenizer.json',
    );
    expect(await getModelStatus(options)).toMatchObject({
      installationState: 'not-installed',
      inferenceAvailable: false,
    });
  });
});

function createReleaseFixture(): {
  files: Map<string, Buffer>;
  release: ModelRelease;
} {
  const files = new Map<string, Buffer>(ARTIFACTS);
  const artifacts = ARTIFACTS.map(([name, bytes]) => ({
    name,
    ...(name === 'Apache-2.0.txt' || name === 'NOTICE'
      ? { repositoryPath: name }
      : {
          upstreamPath:
            name === 'model_quantized.onnx'
              ? 'onnx/model_quantized.onnx'
              : name,
        }),
    requiredForInference: INFERENCE_FILES.has(name),
    sizeBytes: bytes.byteLength,
    sha256: digest(bytes),
  }));
  const tag = `${MODEL_ID}-v${MODEL_VERSION}`;
  const manifest = {
    schemaVersion: 1,
    modelId: MODEL_ID,
    version: MODEL_VERSION,
    release: {
      repository: 'rafaself/nekosearch-models',
      tag,
      checksums: 'SHA256SUMS',
    },
    upstream: {
      repository: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
      revision: UPSTREAM_REVISION,
    },
    model: {
      architecture: 'Qwen3Model',
      format: 'onnx',
      contextLength: 32768,
      embeddingDimensions: 1024,
      pooling: 'last_token',
      normalization: 'l2',
    },
    tokenizer: {
      class: 'Qwen2Tokenizer',
      algorithm: 'BPE',
      files: ['tokenizer.json', 'tokenizer_config.json'],
      paddingSide: 'left',
      padToken: '<|endoftext|>',
      eosToken: '<|im_end|>',
    },
    runtime: {
      package: '@huggingface/transformers',
      version: '4.3.2',
      onnxruntimeNodeVersion: '1.30.0',
      nodeVersion: '24.22.2',
      platform: 'linux',
      architecture: 'x64',
      task: 'feature-extraction',
      device: 'cpu',
      dtype: 'q8',
      subfolder: '',
      externalData: false,
      recommendedBatchSize: 1,
    },
    artifacts,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = digest(manifestBytes);
  const checksumBytes = Buffer.from(
    [
      ...artifacts.map(({ name, sha256 }) => `${sha256}  ${name}`),
      `${manifestSha256}  manifest.json`,
    ].join('\n') + '\n',
  );
  files.set('manifest.json', manifestBytes);
  files.set('SHA256SUMS', checksumBytes);

  return {
    files,
    release: {
      url: `https://models.example.test/releases/download/${tag}`,
      repository: 'rafaself/nekosearch-models',
      tag,
      manifestSha256,
      manifestBytes: manifestBytes.byteLength,
      checksumsSha256: digest(checksumBytes),
      checksumsBytes: checksumBytes.byteLength,
    },
  };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (
    typeof input === 'object' &&
    input !== null &&
    'url' in input &&
    typeof input.url === 'string'
  ) {
    return input.url;
  }
  throw new Error('Unexpected fetch request input');
}
