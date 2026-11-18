import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import {
  QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1,
  type DocumentationEmbeddingProvider,
} from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import type { ModelStatus } from './model-manager.js';

const MAX_CONFIGURATION_BYTES = 64 * 1024;

const NekoSearchConfigurationSchema = z.strictObject({
  search: z
    .strictObject({
      semantic: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface SemanticSearchConfigurationOptions {
  configPath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface SemanticSearchConfiguration {
  enabled: boolean;
  configPath: string;
}

export interface ConfiguredEmbeddingProvider extends DocumentationEmbeddingProvider {
  /** Available on the local runtime provider used by semantic retrieval. */
  embedQuery?: (query: string) => Promise<Float32Array>;
}

export interface ConfiguredEmbeddingProviderOptions extends SemanticSearchConfigurationOptions {
  modelStatusReader?: () => Promise<ModelStatus>;
  embeddingProviderFactory?: () => Promise<DocumentationEmbeddingProvider>;
}

export interface EnableSemanticSearchOptions extends SemanticSearchConfigurationOptions {
  modelStatusReader?: () => Promise<ModelStatus>;
  embeddingStatusesReader?: () => Promise<readonly SemanticSnapshotStatus[]>;
}

export interface SemanticSnapshotStatus {
  selector: string;
  modelCompatibility: 'not built' | 'compatible' | 'incompatible';
  totalChunks: number;
  embeddedChunks: number;
  missingEmbeddings: number;
  invalidEmbeddings: number;
  snapshotIntegrity: 'valid' | 'invalid';
}

/** Read an optional project-level nekosearch.yaml; semantic search defaults off. */
export async function loadSemanticSearchConfiguration(
  options: SemanticSearchConfigurationOptions = {},
): Promise<SemanticSearchConfiguration> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const environmentPath = environment.NEKOSEARCH_CONFIG?.trim();
  const explicitlyConfigured = Boolean(options.configPath || environmentPath);
  const configPath = resolve(
    cwd,
    options.configPath ?? environmentPath ?? 'nekosearch.yaml',
  );

  let contents: Buffer;
  try {
    const fileInfo = await stat(configPath);
    if (!fileInfo.isFile()) {
      throw new Error(
        `Configuration path is not a regular file: ${configPath}`,
      );
    }
    if (fileInfo.size > MAX_CONFIGURATION_BYTES) {
      throw new Error(
        `NekoSearch configuration exceeds ${MAX_CONFIGURATION_BYTES} bytes: ${configPath}`,
      );
    }
    contents = await readFile(configPath);
  } catch (error) {
    if (isMissingFile(error) && !explicitlyConfigured) {
      return { enabled: false, configPath };
    }
    throw new Error(`Unable to read NekoSearch configuration "${configPath}"`, {
      cause: error,
    });
  }

  const document = parseConfigurationDocument(
    contents.toString('utf8'),
    configPath,
  );
  const configurationValue: unknown = document.toJS({ maxAliasCount: 0 });

  const parsed = NekoSearchConfigurationSchema.safeParse(configurationValue);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('\n');
    throw new Error(
      `Invalid NekoSearch configuration "${configPath}":\n${details}`,
    );
  }

  return {
    enabled: parsed.data.search?.semantic?.enabled ?? false,
    configPath,
  };
}

/** Enable only after the installed model and every user snapshot are ready. */
export async function enableSemanticSearch(
  options: EnableSemanticSearchOptions = {},
): Promise<SemanticSearchConfiguration> {
  const status = await (
    options.modelStatusReader ??
    (async () => {
      const modelManager = await import('./model-manager.js');
      return modelManager.getModelStatus({ environment: options.environment });
    })
  )();
  if (
    status.modelId !== QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelId ||
    status.upstreamRevision !==
      QWEN3_DOCUMENTATION_EMBEDDING_SPACE_V1.modelRevision ||
    status.installationState !== 'installed' ||
    status.artifactIntegrity !== 'valid'
  ) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `Semantic Search requires an integrity-verified Qwen3-Embedding-0.6B installation.${details} Run \`nekosearch model install\` and \`nekosearch model status\` before enabling it.`,
    );
  }
  if (!status.inferenceAvailable) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `Semantic Search requires the local inference runtime.${details} Install the optional @huggingface/transformers@4.3.2 runtime on a supported Node.js host before enabling it.`,
    );
  }

  const readStatuses =
    options.embeddingStatusesReader ??
    (async () => {
      const embeddings = await import('./embeddings.js');
      return embeddings.getDocumentationEmbeddingStatuses();
    });
  const statuses = await readStatuses();
  const incomplete = statuses.filter(
    (snapshot) =>
      snapshot.snapshotIntegrity !== 'valid' ||
      snapshot.modelCompatibility !== 'compatible' ||
      snapshot.invalidEmbeddings !== 0 ||
      snapshot.missingEmbeddings !== 0 ||
      snapshot.embeddedChunks !== snapshot.totalChunks,
  );
  if (incomplete.length > 0) {
    const details = incomplete
      .map((snapshot) => {
        const reasons: string[] = [];
        if (snapshot.snapshotIntegrity !== 'valid') {
          reasons.push('snapshot integrity is invalid');
        }
        if (snapshot.modelCompatibility !== 'compatible') {
          reasons.push(`embedding space is ${snapshot.modelCompatibility}`);
        }
        if (snapshot.missingEmbeddings > 0) {
          reasons.push(`${snapshot.missingEmbeddings} embeddings are missing`);
        }
        if (snapshot.invalidEmbeddings > 0) {
          reasons.push(`${snapshot.invalidEmbeddings} embeddings are invalid`);
        }
        return `${snapshot.selector}: ${reasons.join(', ')}`;
      })
      .join('; ');
    const commands = incomplete
      .map((snapshot) => `nekosearch embeddings build ${snapshot.selector}`)
      .join(' && ');
    throw new Error(
      `Semantic Search cannot be enabled until active documentation snapshots have complete, compatible embeddings (${details}). Run ${commands}.`,
    );
  }

  await writeSemanticSearchConfiguration(true, options);
  return loadSemanticSearchConfiguration(options);
}

/** Turn off hybrid retrieval without changing models or snapshot vectors. */
export async function disableSemanticSearch(
  options: SemanticSearchConfigurationOptions = {},
): Promise<SemanticSearchConfiguration> {
  await writeSemanticSearchConfiguration(false, options);
  return loadSemanticSearchConfiguration(options);
}

async function writeSemanticSearchConfiguration(
  enabled: boolean,
  options: SemanticSearchConfigurationOptions,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const configPath = resolve(
    cwd,
    options.configPath ??
      environment.NEKOSEARCH_CONFIG?.trim() ??
      'nekosearch.yaml',
  );
  const parentDirectory = dirname(configPath);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });

  let currentContents: Buffer | undefined;
  let mode = 0o600;
  try {
    const fileInfo = await lstat(configPath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(
        `Configuration path is not a regular file: ${configPath}`,
      );
    }
    if (fileInfo.size > MAX_CONFIGURATION_BYTES) {
      throw new Error(
        `NekoSearch configuration exceeds ${MAX_CONFIGURATION_BYTES} bytes: ${configPath}`,
      );
    }
    currentContents = await readFile(configPath);
    mode = fileInfo.mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const document = parseConfigurationDocument(
    currentContents?.toString('utf8') ?? '',
    configPath,
  );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const parsed = NekoSearchConfigurationSchema.safeParse(value);
  if (currentContents !== undefined && !parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('\n');
    throw new Error(
      `Invalid NekoSearch configuration "${configPath}":\n${details}`,
    );
  }
  document.setIn(['search', 'semantic', 'enabled'], enabled);
  const contents = stringify(document);
  if (Buffer.byteLength(contents, 'utf8') > MAX_CONFIGURATION_BYTES) {
    throw new Error(
      `NekoSearch configuration exceeds ${MAX_CONFIGURATION_BYTES} bytes: ${configPath}`,
    );
  }

  const temporaryPath = join(
    parentDirectory,
    `.${basename(configPath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, configPath);
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

function parseConfigurationDocument(contents: string, configPath: string) {
  try {
    const document = parseDocument(contents, {
      stringKeys: true,
      uniqueKeys: true,
      version: '1.2',
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error(
        [...document.errors, ...document.warnings]
          .map((issue) => issue.message)
          .join('\n'),
      );
    }
    return document;
  } catch (error) {
    throw new Error(`Invalid NekoSearch YAML in "${configPath}"`, {
      cause: error,
    });
  }
}

/** Resolve the local model provider only when semantic search is enabled. */
export async function resolveConfiguredEmbeddingProvider(
  options: ConfiguredEmbeddingProviderOptions = {},
): Promise<ConfiguredEmbeddingProvider | undefined> {
  const configuration = await loadSemanticSearchConfiguration(options);
  if (!configuration.enabled) return undefined;

  const modelStatusReader =
    options.modelStatusReader ??
    (async () => {
      const modelManager = await import('./model-manager.js');
      return modelManager.getModelStatus();
    });
  const status = await modelStatusReader();
  if (
    status.installationState !== 'installed' ||
    status.artifactIntegrity !== 'valid'
  ) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `Semantic Search is enabled in "${configuration.configPath}", but Qwen3 is not installed and verified at ${status.modelDirectory}.${details} Run \`nekosearch model install\` and retry; ingestion never downloads the model implicitly.`,
    );
  }
  if (!status.inferenceAvailable) {
    const details = status.details.length
      ? ` ${status.details.join('; ')}`
      : '';
    throw new Error(
      `Semantic Search is enabled in "${configuration.configPath}", but the local inference runtime is unavailable.${details} Install the optional @huggingface/transformers@4.3.2 runtime and use a supported Node.js host before retrying.`,
    );
  }

  if (options.embeddingProviderFactory) {
    return options.embeddingProviderFactory();
  }
  const embeddingRuntime = await import('./local-qwen3-embedding-generator.js');
  const generator = embeddingRuntime.createLocalQwen3EmbeddingGenerator();
  return {
    embeddingSpace: embeddingRuntime.LOCAL_QWEN3_EMBEDDING_SPACE,
    embedDocuments: (documents) => generator.embedDocuments(documents),
    embedQuery: (query) => generator.embedQuery(query),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
