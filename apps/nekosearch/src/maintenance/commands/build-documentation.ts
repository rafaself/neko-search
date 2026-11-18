import { parseArgs } from 'node:util';
import { buildLocalDocumentationCommand } from './build-local-documentation.js';
import { buildNestJsDocumentationCommand } from './build-nestjs-documentation.js';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';

export async function buildDocumentationCommand(
  args: string[],
  embeddingProvider?: DocumentationEmbeddingProvider,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      config: { type: 'string' },
      output: { type: 'string' },
      clean: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const source = values.source ?? (values.config ? 'local' : undefined);

  if (source === 'local') {
    if (!values.config) {
      throw new Error('The local source requires --config <path>');
    }
    if (values.output) {
      throw new Error('Set the local outputDirectory in the config file');
    }
    await buildLocalDocumentationCommand(
      ['--config', values.config, ...(values.clean ? ['--clean'] : [])],
      embeddingProvider,
    );
    return;
  }

  if (source === 'nestjs') {
    if (values.config) {
      throw new Error('The NestJS source does not accept --config');
    }
    await buildNestJsDocumentationCommand(
      [
        ...(values.output ? ['--output', values.output] : []),
        ...(values.clean ? ['--clean'] : []),
      ],
      embeddingProvider,
    );
    return;
  }

  throw new Error(
    'Choose a build source: --source local --config <path> or --source nestjs',
  );
}
