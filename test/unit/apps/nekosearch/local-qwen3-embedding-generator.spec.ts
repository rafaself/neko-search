import {
  createLocalQwen3EmbeddingGenerator,
  type LocalQwen3EmbeddingGeneratorOptions,
} from '../../../../src/apps/nekosearch/local-qwen3-embedding-generator.js';
import type { ModelStatus } from '../../../../src/apps/nekosearch/model-manager.js';
import type {
  RuntimeModelInputs,
  RuntimePipeline,
  RuntimeTensor,
  TransformersRuntimeModule,
} from '../../../../src/apps/nekosearch/transformers-runtime.js';

const MODEL_DIRECTORY = '/models/qwen3-embedding-0.6b/1.0.0';

describe('local Qwen3 embedding generator', () => {
  it('uses the verified local pipeline, normalizes masked last tokens, and reuses it', async () => {
    const runtime = createFakeRuntime();
    const generator = createGenerator(runtime.module);

    const documents = await generator.embedDocuments(['Document one']);
    const firstQuery = await generator.embedQuery('How does the API work?');
    await generator.embedQuery('How does the API work?');

    expect(runtime.loadCount()).toBe(1);
    expect(runtime.inputs()).toEqual([
      ['Document one'],
      [
        'Instruct: Given a query about software documentation, retrieve relevant documentation passages that answer the query\nQuery:How does the API work?',
      ],
      [
        'Instruct: Given a query about software documentation, retrieve relevant documentation passages that answer the query\nQuery:How does the API work?',
      ],
    ]);
    expect(runtime.options()).toEqual({
      device: 'cpu',
      dtype: 'q8',
      subfolder: '',
      local_files_only: true,
      use_external_data_format: false,
      session_options: {
        intra_op_num_threads: 4,
        inter_op_num_threads: 1,
      },
    });
    expect(runtime.module.env.allowRemoteModels).toBe(false);
    expect(runtime.module.env.allowLocalModels).toBe(true);
    expect(runtime.tokenizerOptions()).toEqual({
      padding: true,
      truncation: true,
      max_length: 8192,
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toHaveLength(1024);
    expect(firstQuery).toHaveLength(1024);
    expect(firstQuery[0]).toBeCloseTo(0.6, 5);
    expect(firstQuery[1]).toBeCloseTo(0.8, 5);
    expect(Math.hypot(...firstQuery)).toBeCloseTo(1, 6);
  });

  it('shares and serializes one model across generator instances', async () => {
    const runtime = createFakeRuntime();
    const generator = createGenerator(runtime.module);
    const secondGenerator = createGenerator(runtime.module);

    await Promise.all([
      generator.embedQuery('first query'),
      secondGenerator.embedQuery('second query'),
      secondGenerator.embedDocuments(['one', 'two']),
    ]);

    expect(runtime.loadCount()).toBe(1);
    expect(runtime.maxConcurrentModelCalls()).toBe(1);
  });

  it('rejects unavailable models, blank input, and invalid inference output explicitly', async () => {
    const runtime = createFakeRuntime();
    const missingModel = createGenerator(runtime.module, {
      modelStatusReader: () =>
        Promise.resolve({
          ...readyStatus(),
          installationState: 'corrupt',
          artifactIntegrity: 'invalid',
          inferenceAvailable: false,
        }),
    });
    await expect(missingModel.embedQuery('query')).rejects.toThrow(
      'not installed and verified',
    );
    await expect(missingModel.embedQuery('   ')).rejects.toThrow(
      'query must be a non-empty string',
    );
    expect(runtime.loadCount()).toBe(0);

    const invalidOutput = createFakeRuntime({ zeroOutput: true });
    const generator = createGenerator(invalidOutput.module);
    await expect(generator.embedQuery('query')).rejects.toThrow(
      'zero-length embedding',
    );
  });
});

function createGenerator(
  transformersRuntime: TransformersRuntimeModule,
  options: Pick<LocalQwen3EmbeddingGeneratorOptions, 'modelStatusReader'> = {},
) {
  return createLocalQwen3EmbeddingGenerator({
    modelDirectory: MODEL_DIRECTORY,
    transformersRuntime,
    modelStatusReader: () => Promise.resolve(readyStatus()),
    ...options,
  });
}

function readyStatus(): ModelStatus {
  return {
    modelId: 'qwen3-embedding-0.6b',
    installationState: 'installed',
    version: '1.0.0',
    upstreamRevision: 'c25a394dd583836952667c12f008335071b3f43d',
    modelDirectory: MODEL_DIRECTORY,
    artifactIntegrity: 'valid',
    runtimeAvailable: true,
    inferenceAvailable: true,
    runtimeRequirement:
      '@huggingface/transformers@4.3.2 with onnxruntime-node@1.30.0 on Linux x64 Node.js 24.22.2',
    details: [],
    unmanagedFiles: [],
  };
}

function createFakeRuntime(runtimeOptions: { zeroOutput?: boolean } = {}) {
  const receivedInputs: string[][] = [];
  const receivedTokenizeOptions: unknown[] = [];
  let loadCount = 0;
  let currentModelCalls = 0;
  let maxConcurrentModelCalls = 0;
  let pipelineOptions: unknown;

  const tokenizer = Object.assign(
    (
      texts: string[],
      tokenizeOptions: {
        padding: true;
        truncation: true;
        max_length: number;
      },
    ): RuntimeModelInputs => {
      receivedInputs.push([...texts]);
      receivedTokenizeOptions.push(tokenizeOptions);
      return {
        input_ids: tensor([1, 3], [0n, 11n, 12n]),
        attention_mask: tensor([1, 3], [0n, 1n, 1n]),
      };
    },
    { padding_side: 'left' },
  );

  const module: TransformersRuntimeModule = {
    env: {
      version: '4.3.2',
      allowRemoteModels: true,
      allowLocalModels: false,
    },
    pipeline: (_task, modelDirectory, runtimePipelineOptions) => {
      loadCount += 1;
      expect(modelDirectory).toBe(MODEL_DIRECTORY);
      pipelineOptions = runtimePipelineOptions;
      const pipeline: RuntimePipeline = {
        tokenizer,
        model: async () => {
          currentModelCalls += 1;
          maxConcurrentModelCalls = Math.max(
            maxConcurrentModelCalls,
            currentModelCalls,
          );
          await new Promise((resolve) => setTimeout(resolve, 2));
          currentModelCalls -= 1;
          return {
            last_hidden_state: fakeHiddenState(runtimeOptions.zeroOutput),
          };
        },
      };
      return Promise.resolve(pipeline);
    },
  };

  return {
    module,
    loadCount: () => loadCount,
    inputs: () => receivedInputs,
    options: () => pipelineOptions,
    tokenizerOptions: () => receivedTokenizeOptions[0],
    maxConcurrentModelCalls: () => maxConcurrentModelCalls,
  };
}

function fakeHiddenState(zeroOutput = false): RuntimeTensor {
  const data = new Float32Array(3 * 1024);
  if (!zeroOutput) {
    data[0] = 1_000;
    data[2048] = 3;
    data[2049] = 4;
    data[1024] = 1;
  }
  return { dims: [1, 3, 1024], data };
}

function tensor(
  dims: number[],
  values: ArrayLike<number | bigint>,
): RuntimeTensor {
  return { dims, data: values };
}
