import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserDataDirectory } from './catalog.js';

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

export function resolveManagedRuntimeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(
    getUserDataDirectory(environment),
    'runtimes',
    `transformers-${TRANSFORMERS_VERSION}-onnx-${ONNX_RUNTIME_NODE_VERSION}`,
  );
}

export function getRuntimeHostProblem(): string | undefined {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    major < 24 ||
    (major === 24 && minor < 15)
  ) {
    return `Local Qwen3 inference requires Linux x64 with Node.js >=24.15.0. Current host: ${process.platform} ${process.arch}, Node.js ${process.versions.node}.`;
  }
  return undefined;
}

/** Load only the local runtime; model files are never resolved here. */
export function inspectTransformersRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): TransformersRuntimeStatus {
  const persistent = inspectPersistentTransformersRuntime(environment);
  if (persistent?.available) return persistent;
  const workingDirectory = inspectRuntime(
    createRequire(join(process.cwd(), 'nekosearch-runtime-loader.cjs')),
  );
  if (workingDirectory?.available) return workingDirectory;
  if (persistent) return persistent;
  if (workingDirectory) return workingDirectory;
  return {
    available: false,
    detail: `Optional runtime @huggingface/transformers@${TRANSFORMERS_VERSION} is not installed. Run \`nekosearch model install\` or choose Install now in setup.`,
  };
}

/** A runtime reachable regardless of the MCP client's working directory. */
export function inspectPersistentTransformersRuntime(
  environment: NodeJS.ProcessEnv,
): TransformersRuntimeStatus | undefined {
  const managed = inspectRuntimeDirectory(
    resolveManagedRuntimeDirectory(environment),
  );
  if (managed?.available) return managed;
  return (
    inspectRuntime(createRequire(fileURLToPath(import.meta.url))) ?? managed
  );
}

export function inspectRuntimeDirectory(
  directory: string,
): TransformersRuntimeStatus | undefined {
  const modules = join(directory, 'node_modules');
  // Avoid asking Node to resolve a package under a path that does not exist yet.
  // Setup may create that path and load the runtime later in the same process.
  if (!existsSync(join(modules, TRANSFORMERS_PACKAGE, 'package.json')))
    return undefined;
  return inspectRuntime(
    createRequire(join(directory, 'package.json')),
    realpathSync(modules),
  );
}

function inspectRuntime(
  runtimeRequire: NodeJS.Require,
  managedModules?: string,
): TransformersRuntimeStatus | undefined {
  let transformersEntry: string;
  try {
    transformersEntry = runtimeRequire.resolve(TRANSFORMERS_PACKAGE);
    if (managedModules && !isInside(managedModules, transformersEntry))
      return undefined;
  } catch (error) {
    if (isModuleNotFound(error)) return undefined;
    return {
      available: false,
      detail: `Could not locate the optional Transformers.js runtime: ${errorMessage(error)}`,
    };
  }
  try {
    const transformersManifest = readPackageManifest(
      transformersEntry,
      TRANSFORMERS_PACKAGE,
    );
    const onnxRuntimeRequire = createRequire(transformersEntry);
    const onnxRuntimeEntry = onnxRuntimeRequire.resolve('onnxruntime-node');
    if (managedModules && !isInside(managedModules, onnxRuntimeEntry)) {
      throw new Error(
        'The managed ONNX Runtime resolved outside its installation',
      );
    }
    const onnxRuntimeManifest = readPackageManifest(
      onnxRuntimeEntry,
      'onnxruntime-node',
    );
    const transformersVersion = transformersManifest.version;
    const onnxRuntimeNodeVersion = onnxRuntimeManifest.version;
    if (
      transformersVersion !== TRANSFORMERS_VERSION ||
      onnxRuntimeNodeVersion !== ONNX_RUNTIME_NODE_VERSION
    ) {
      return {
        available: false,
        detail: `Expected @huggingface/transformers@${TRANSFORMERS_VERSION} with onnxruntime-node@${ONNX_RUNTIME_NODE_VERSION}; found @huggingface/transformers@${transformersVersion} with onnxruntime-node@${onnxRuntimeNodeVersion}`,
        transformersVersion,
        onnxRuntimeNodeVersion,
      };
    }
    const module = runtimeRequire(
      transformersEntry,
    ) as TransformersRuntimeModule;
    onnxRuntimeRequire(onnxRuntimeEntry);
    if (
      module.env?.version !== TRANSFORMERS_VERSION ||
      typeof module.pipeline !== 'function'
    ) {
      throw new Error(
        'The installed Transformers.js runtime did not expose the expected API',
      );
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

function isInside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return !!rest && !rest.startsWith('..') && !isAbsolute(rest);
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
