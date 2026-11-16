import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface LocalBuildConfiguration {
  id: string;
  version: string;
  inputDirectory: string;
  outputDirectory: string;
  routeMapping: {
    baseUrl: string;
    pathPrefix: string;
    indexFileNames: string[];
  };
}

interface LocalBuildSummary {
  id: string;
  version: string;
  sourceRevision: string;
  outputDirectory: string;
  documentCount: number;
  chunkCount: number;
  diagnostics: Array<{
    path: string;
    line: number;
    column: number;
    message: string;
  }>;
  cleanupWarning?: string;
}

interface BuildLocalDocumentationModule {
  buildLocalDocumentation(
    config: LocalBuildConfiguration,
    options: { mode: 'clean' | 'incremental' },
  ): Promise<LocalBuildSummary>;
}

/** Build a local snapshot without installing it in the catalog. */
export async function buildLocalSnapshot(args: string[]) {
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

  const buildServicePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'build-runtime/services/build-local-documentation.js',
  );
  const buildService = (await import(
    pathToFileURL(buildServicePath).href
  )) as BuildLocalDocumentationModule;
  return buildService.buildLocalDocumentation(configuration, {
    mode: values.clean ? 'clean' : 'incremental',
  });
}
