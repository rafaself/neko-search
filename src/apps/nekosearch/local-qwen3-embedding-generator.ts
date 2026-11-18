import {
  getModelStatus,
  resolveModelDirectory,
  type ModelManagerOptions,
  type ModelStatus,
} from './model-manager.js';
import type { EmbeddingGenerator } from './embedding-generator.js';
import {
  inspectTransformersRuntime,
  TRANSFORMERS_VERSION,
  type RuntimePipeline,
  type TransformersRuntimeModule,
} from './transformers-runtime.js';

const EMBEDDING_DIMENSIONS = 1024;
const MAX_SEQUENCE_LENGTH = 8192;
const MODEL_BATCH_SIZE = 1;
const QUERY_INSTRUCTION =
  'Given a query about software documentation, retrieve relevant documentation passages that answer the query';

interface SharedModelRuntime {
  pipelinePromise?: Promise<RuntimePipeline>;
  inferenceQueue: Promise<void>;
}

const sharedModels = new WeakMap<
  TransformersRuntimeModule,
  Map<string, SharedModelRuntime>
>();

export interface LocalQwen3EmbeddingGeneratorOptions {
  /** Exact model directory; defaults to the versioned Model Manager directory. */
  modelDirectory?: string;
  /** Runtime injection and status reader are useful for isolated tests and hosts. */
  transformersRuntime?: TransformersRuntimeModule;
  modelStatusReader?: (
    options: Pick<ModelManagerOptions, 'modelDirectory'>,
  ) => Promise<ModelStatus>;
}

export function createLocalQwen3EmbeddingGenerator(
  options: LocalQwen3EmbeddingGeneratorOptions = {},
): EmbeddingGenerator {
  return new LocalQwen3EmbeddingGenerator(options);
}

class LocalQwen3EmbeddingGenerator implements EmbeddingGenerator {
  private readonly modelDirectory: string;
  private readonly modelStatusReader: NonNullable<
    LocalQwen3EmbeddingGeneratorOptions['modelStatusReader']
  >;
  private readonly transformersRuntime?: TransformersRuntimeModule;
  private sharedRuntimePromise?: Promise<SharedModelRuntime>;

  constructor(options: LocalQwen3EmbeddingGeneratorOptions) {
    this.modelDirectory = resolveModelDirectory({
      modelDirectory: options.modelDirectory,
    });
    this.modelStatusReader = options.modelStatusReader ?? getModelStatus;
    this.transformersRuntime = options.transformersRuntime;
  }

  async embedDocuments(documents: string[]): Promise<Float32Array[]> {
    validateTexts(documents, 'documents');
    if (documents.length === 0) return [];
    const runtime = await this.getSharedRuntime();
    return this.serialize(runtime, () => this.embedTexts(runtime, documents));
  }

  async embedQuery(query: string): Promise<Float32Array> {
    validateText(query, 'query');
    const instructedQuery = `Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`;
    const runtime = await this.getSharedRuntime();
    const [embedding] = await this.serialize(runtime, () =>
      this.embedTexts(runtime, [instructedQuery]),
    );
    if (!embedding) throw new Error('Qwen3 did not return a query embedding');
    return embedding;
  }

  private async embedTexts(
    runtime: SharedModelRuntime,
    texts: string[],
  ): Promise<Float32Array[]> {
    if (!runtime.pipelinePromise) {
      throw new Error('Qwen3 runtime was not initialized');
    }
    const pipeline = await runtime.pipelinePromise;
    const embeddings: Float32Array[] = [];

    for (let offset = 0; offset < texts.length; offset += MODEL_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + MODEL_BATCH_SIZE);
      let modelInputs;
      let output;
      try {
        modelInputs = pipeline.tokenizer(batch, {
          padding: true,
          truncation: true,
          max_length: MAX_SEQUENCE_LENGTH,
        });
        output = await pipeline.model(modelInputs);
      } catch (error) {
        throw new Error(
          `Qwen3 embedding inference failed: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      }

      if (!output.last_hidden_state) {
        throw new Error('Qwen3 runtime returned no last_hidden_state tensor');
      }
      embeddings.push(
        ...poolLastActiveToken(
          output.last_hidden_state,
          modelInputs.attention_mask,
          batch.length,
        ),
      );
    }

    return embeddings;
  }

  private async getSharedRuntime(): Promise<SharedModelRuntime> {
    if (!this.sharedRuntimePromise) {
      this.sharedRuntimePromise = this.createOrReuseSharedRuntime();
    }
    try {
      return await this.sharedRuntimePromise;
    } catch (error) {
      this.sharedRuntimePromise = undefined;
      throw error;
    }
  }

  private async createOrReuseSharedRuntime(): Promise<SharedModelRuntime> {
    const status = await this.modelStatusReader({
      modelDirectory: this.modelDirectory,
    });
    if (
      status.installationState !== 'installed' ||
      status.artifactIntegrity !== 'valid'
    ) {
      throw new Error(
        `Qwen3 model is not installed and verified at ${this.modelDirectory} (state: ${status.installationState}, integrity: ${status.artifactIntegrity})`,
      );
    }
    if (!isSupportedRuntime(status)) {
      throw new Error(
        status.details.join('; ') ||
          `Qwen3 inference requires Linux x64 Node.js ${status.runtimeRequirement}`,
      );
    }

    const runtimeStatus = this.transformersRuntime
      ? {
          available:
            this.transformersRuntime.env.version === TRANSFORMERS_VERSION,
          module: this.transformersRuntime,
          detail: `Expected @huggingface/transformers@${TRANSFORMERS_VERSION}, found ${this.transformersRuntime.env.version}`,
        }
      : inspectTransformersRuntime();
    if (!runtimeStatus.available) {
      throw new Error(runtimeStatus.detail);
    }

    const runtimeModule = runtimeStatus.module;
    runtimeModule.env.allowRemoteModels = false;
    runtimeModule.env.allowLocalModels = true;
    let modelsByDirectory = sharedModels.get(runtimeModule);
    if (!modelsByDirectory) {
      modelsByDirectory = new Map();
      sharedModels.set(runtimeModule, modelsByDirectory);
    }

    let sharedRuntime = modelsByDirectory.get(this.modelDirectory);
    if (!sharedRuntime) {
      sharedRuntime = { inferenceQueue: Promise.resolve() };
      modelsByDirectory.set(this.modelDirectory, sharedRuntime);
    }
    if (!sharedRuntime.pipelinePromise) {
      sharedRuntime.pipelinePromise = this.loadPipeline(runtimeModule);
    }
    try {
      await sharedRuntime.pipelinePromise;
    } catch (error) {
      if (modelsByDirectory.get(this.modelDirectory) === sharedRuntime) {
        modelsByDirectory.delete(this.modelDirectory);
      }
      throw error;
    }
    return sharedRuntime;
  }

  private async loadPipeline(
    runtimeModule: TransformersRuntimeModule,
  ): Promise<RuntimePipeline> {
    try {
      const pipeline = await runtimeModule.pipeline(
        'feature-extraction',
        this.modelDirectory,
        {
          device: 'cpu',
          dtype: 'q8',
          subfolder: '',
          local_files_only: true,
          use_external_data_format: false,
          session_options: {
            intra_op_num_threads: 4,
            inter_op_num_threads: 1,
          },
        },
      );
      if (pipeline.tokenizer.padding_side !== 'left') {
        throw new Error(
          `Qwen3 requires left padding for the validated model files; tokenizer uses ${pipeline.tokenizer.padding_side}`,
        );
      }
      return pipeline;
    } catch (error) {
      throw new Error(
        `Could not load the verified local Qwen3 model: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private serialize<T>(
    runtime: SharedModelRuntime,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = runtime.inferenceQueue.then(operation);
    runtime.inferenceQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function poolLastActiveToken(
  hidden: { dims: number[]; data: ArrayLike<number | bigint> },
  attentionMask: { dims: number[]; data: ArrayLike<number | bigint> },
  expectedBatchSize: number,
): Float32Array[] {
  if (hidden.dims.length !== 3 || attentionMask.dims.length !== 2) {
    throw new Error(
      `Qwen3 returned incompatible tensor ranks (hidden: ${hidden.dims.length}, attention mask: ${attentionMask.dims.length})`,
    );
  }
  const [batchSize, sequenceLength, dimensions] = hidden.dims;
  if (
    !Number.isSafeInteger(batchSize) ||
    !Number.isSafeInteger(sequenceLength) ||
    !Number.isSafeInteger(dimensions) ||
    batchSize !== expectedBatchSize ||
    sequenceLength === undefined ||
    sequenceLength < 1 ||
    dimensions !== EMBEDDING_DIMENSIONS ||
    attentionMask.dims[0] !== batchSize ||
    attentionMask.dims[1] !== sequenceLength
  ) {
    throw new Error(
      `Qwen3 returned incompatible tensor shapes (hidden: ${hidden.dims.join('x')}, attention mask: ${attentionMask.dims.join('x')})`,
    );
  }
  if (
    hidden.data.length < batchSize * sequenceLength * dimensions ||
    attentionMask.data.length < batchSize * sequenceLength
  ) {
    throw new Error('Qwen3 returned tensors with incomplete data');
  }

  const embeddings: Float32Array[] = [];
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    let lastTokenIndex = sequenceLength - 1;
    for (let index = 0; index < sequenceLength; index += 1) {
      const maskValue = Number(
        attentionMask.data[batchIndex * sequenceLength + index],
      );
      if (maskValue !== 0 && maskValue !== 1) {
        throw new Error(
          `Qwen3 tokenizer returned an invalid attention mask at batch index ${batchIndex}, token ${index}`,
        );
      }
    }
    while (lastTokenIndex >= 0) {
      const maskValue = Number(
        attentionMask.data[batchIndex * sequenceLength + lastTokenIndex],
      );
      if (maskValue === 1) break;
      lastTokenIndex -= 1;
    }
    if (lastTokenIndex < 0) {
      throw new Error(
        `Qwen3 tokenizer produced an empty attention mask at batch index ${batchIndex}`,
      );
    }

    const tokenOffset =
      (batchIndex * sequenceLength + lastTokenIndex) * dimensions;
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
    let squaredNorm = 0;
    for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
      const value = Number(hidden.data[tokenOffset + dimension]);
      if (!Number.isFinite(value)) {
        throw new Error(
          `Qwen3 returned a non-finite value at batch index ${batchIndex}, dimension ${dimension}`,
        );
      }
      embedding[dimension] = value;
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm <= 0) {
      throw new Error(
        `Qwen3 returned a zero-length embedding at batch index ${batchIndex}`,
      );
    }
    for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension += 1) {
      const value = embedding[dimension];
      if (value === undefined) {
        throw new Error('Qwen3 produced an incomplete embedding vector');
      }
      embedding[dimension] = value / norm;
    }
    embeddings.push(embedding);
  }
  return embeddings;
}

function isSupportedRuntime(status: ModelStatus): boolean {
  return status.runtimeAvailable;
}

function validateTexts(texts: string[], name: string): void {
  if (!Array.isArray(texts)) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  texts.forEach((text, index) => validateText(text, `${name}[${index}]`));
}

function validateText(text: string, name: string): void {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
