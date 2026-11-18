import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
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

  let configurationValue: unknown;
  try {
    const document = parseDocument(contents.toString('utf8'), {
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
    configurationValue = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`Invalid NekoSearch YAML in "${configPath}"`, {
      cause: error,
    });
  }

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
