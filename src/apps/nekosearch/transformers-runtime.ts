import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRANSFORMERS_VERSION = '4.3.2';
export const ONNX_RUNTIME_NODE_VERSION = '1.30.0';

const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

export interface RuntimeTensor {
  dims: number[];
  data: ArrayLike<number | bigint>;
}

export interface RuntimeModelInputs extends Record<string, unknown> {
  input_ids: RuntimeTensor;
  attention_mask: RuntimeTensor;
}

export interface RuntimeTokenizer {
  padding_side: string;
  (
    texts: string[],
    options: {
      padding: true;
      truncation: true;
      max_length: number;
    },
  ): RuntimeModelInputs;
}

export interface RuntimePipeline {
  tokenizer: RuntimeTokenizer;
  model(
    inputs: RuntimeModelInputs,
  ): Promise<{ last_hidden_state?: RuntimeTensor }>;
}

export interface TransformersRuntimeModule {
  env: {
    version: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
  };
  pipeline(
    task: 'feature-extraction',
    modelDirectory: string,
    options: {
      device: 'cpu';
      dtype: 'q8';
      subfolder: '';
      local_files_only: true;
      use_external_data_format: false;
      session_options: {
        intra_op_num_threads: number;
        inter_op_num_threads: 1;
      };
    },
  ): Promise<RuntimePipeline>;
}

export type TransformersRuntimeStatus =
  | {
      available: true;
      module: TransformersRuntimeModule;
      transformersVersion: string;
      onnxRuntimeNodeVersion: string;
    }
  | {
      available: false;
      detail: string;
      transformersVersion?: string;
      onnxRuntimeNodeVersion?: string;
    };

/** Load only the optional Node runtime; model files are never resolved here. */
export function inspectTransformersRuntime(): TransformersRuntimeStatus {
  const requireCandidates = [
    createRequire(fileURLToPath(import.meta.url)),
    createRequire(join(process.cwd(), 'nekosearch-runtime-loader.cjs')),
  ];

  for (const runtimeRequire of requireCandidates) {
    let transformersEntry: string;
    try {
      transformersEntry = runtimeRequire.resolve(TRANSFORMERS_PACKAGE);
    } catch (error) {
      if (isModuleNotFound(error)) continue;
      return {
        available: false,
        detail: `Could not locate the optional Transformers.js runtime: ${errorMessage(error)}`,
      };
    }
    try {
      const module = runtimeRequire(
        TRANSFORMERS_PACKAGE,
      ) as TransformersRuntimeModule;
      const transformersManifest = readPackageManifest(
        transformersEntry,
        TRANSFORMERS_PACKAGE,
      );
      const onnxRuntimeRequire = createRequire(transformersEntry);
      const onnxRuntimeEntry = onnxRuntimeRequire.resolve('onnxruntime-node');
      const onnxRuntimeManifest = readPackageManifest(
        onnxRuntimeEntry,
        'onnxruntime-node',
      );
      const transformersVersion =
        module.env?.version ?? transformersManifest.version;
      const onnxRuntimeNodeVersion = onnxRuntimeManifest.version;

      if (
        transformersVersion !== TRANSFORMERS_VERSION ||
        transformersManifest.version !== TRANSFORMERS_VERSION ||
        onnxRuntimeNodeVersion !== ONNX_RUNTIME_NODE_VERSION
      ) {
        return {
          available: false,
          detail: `Expected @huggingface/transformers@${TRANSFORMERS_VERSION} with onnxruntime-node@${ONNX_RUNTIME_NODE_VERSION}; found @huggingface/transformers@${transformersVersion} with onnxruntime-node@${onnxRuntimeNodeVersion}`,
          transformersVersion,
          onnxRuntimeNodeVersion,
        };
      }

      return {
        available: true,
        module,
        transformersVersion,
        onnxRuntimeNodeVersion,
      };
    } catch (error) {
      return {
        available: false,
        detail: `The optional local inference runtime could not be loaded: ${errorMessage(error)}`,
      };
    }
  }

  return {
    available: false,
    detail: `Optional runtime @huggingface/transformers@${TRANSFORMERS_VERSION} is not installed. Install it in the application directory that launches NekoSearch to enable local inference.`,
  };
}

function readPackageManifest(
  entryFile: string,
  expectedName: string,
): {
  name?: string;
  version?: string;
} {
  let directory = dirname(entryFile);
  while (true) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'name' in parsed &&
        parsed.name === expectedName
      ) {
        return parsed as { name: string; version?: string };
      }
    } catch (error) {
      if (!isMissingPath(error) && !(error instanceof SyntaxError)) throw error;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find package.json for ${expectedName}`);
    }
    directory = parent;
  }
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND'
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
