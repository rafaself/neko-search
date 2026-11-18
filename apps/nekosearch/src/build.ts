import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DocumentationBuildConfigInput } from '@nestjs-docs/documentation-engine/build/documentation-build-config.js';
import type { BuildLocalDocumentationOptions } from '@nestjs-docs/documentation-engine/build/build-local-documentation.js';
import type { DocumentationBuildSummary } from '@nestjs-docs/documentation-engine/build/build-documentation-snapshot.js';

export type LocalBuildConfiguration = DocumentationBuildConfigInput;
export type LocalBuildOptions = BuildLocalDocumentationOptions;

/** Build a local snapshot without installing it in the catalog. */
export async function buildLocalSnapshot(
  args: string[],
  options: Pick<LocalBuildOptions, 'embeddingProvider'> = {},
) {
  const { positionals, values } = parseArgs({
    args,
    options: {
      id: { type: 'string' },
      output: { type: 'string' },
      clean: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error(
      'The build command requires one local documentation directory',
    );
  }
  if (!values.id) {
    throw new Error('The build command requires --id <source@version>');
  }
  if (!values.output) {
    throw new Error('The build command requires --output <snapshot-directory>');
  }

  const identitySeparator = values.id.lastIndexOf('@');
  const id = values.id.slice(0, identitySeparator);
  const version = values.id.slice(identitySeparator + 1);
  if (identitySeparator < 1 || !version) {
    throw new Error('--id must use the form <source>@<version>');
  }

  const scope = createHash('sha256')
    .update(`${id}\0${version}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const configuration: LocalBuildConfiguration = {
    id,
    version,
    inputDirectory: resolve(positionals[0]),
    outputDirectory: resolve(values.output),
    routeMapping: {
      baseUrl: `https://docs.example/${scope}`,
      pathPrefix: '',
      indexFileNames: ['index', 'readme'],
    },
  };

  return buildLocalSnapshotConfiguration(configuration, {
    mode: values.clean ? 'clean' : 'incremental',
    ...options,
  });
}

/** Build a configured local source through the same Markdown/MDX indexer. */
export async function buildLocalSnapshotConfiguration(
  configuration: LocalBuildConfiguration,
  options: LocalBuildOptions,
): Promise<DocumentationBuildSummary> {
  let embeddingProvider = options.embeddingProvider;
  if (!embeddingProvider) {
    const { resolveConfiguredEmbeddingProvider } =
      await import('./semantic-search.js');
    embeddingProvider = await resolveConfiguredEmbeddingProvider();
  }
  const { buildLocalDocumentation } =
    await import('@nestjs-docs/documentation-engine/build/build-local-documentation.js');
  return buildLocalDocumentation(configuration, {
    ...options,
    ...(embeddingProvider && { embeddingProvider }),
  });
}
