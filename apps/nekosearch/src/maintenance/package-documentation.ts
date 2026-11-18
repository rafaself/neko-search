import { buildDocumentationCommand } from './commands/build-documentation.js';
import { resolveConfiguredEmbeddingProvider } from '../semantic-search.js';

async function main(): Promise<void> {
  const embeddingProvider = await resolveConfiguredEmbeddingProvider();
  await buildDocumentationCommand(process.argv.slice(2), embeddingProvider);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Documentation package build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
