import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DocumentationEmbeddingProvider } from '@nestjs-docs/documentation-engine/domain/documentation-embedding.schemas.js';
import { resolveConfiguredEmbeddingProvider } from './semantic-search.js';

interface DocumentationBuildCommandModule {
  buildDocumentationCommand(
    args: string[],
    embeddingProvider?: DocumentationEmbeddingProvider,
  ): Promise<void>;
}

async function main(): Promise<void> {
  const embeddingProvider = await resolveConfiguredEmbeddingProvider();
  const commandPath = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../apps/docs-indexer/dist/commands/build-documentation.js',
  );
  const command = (await import(
    pathToFileURL(commandPath).href
  )) as DocumentationBuildCommandModule;
  await command.buildDocumentationCommand(
    process.argv.slice(2),
    embeddingProvider,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Documentation package build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
