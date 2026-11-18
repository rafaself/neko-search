import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = resolve(root, 'apps/docs-indexer/dist');
const targetRoot = resolve(root, 'dist/apps/nekosearch/build-runtime');
const runtimeFiles = [
  'config/documentation-build-config.js',
  'integrations/nestjs/documentation.integration.js',
  'integrations/nestjs/github/documentation-source.js',
  'integrations/nestjs/nestjs-documentation-transformer.js',
  'integrations/nestjs/source-recipes.js',
  'integrations/nestjs/version/documentation-version.js',
  'services/build-documentation-snapshot.js',
  'services/build-local-documentation.js',
];

await rm(targetRoot, { recursive: true, force: true });
for (const relativePath of runtimeFiles) {
  const targetPath = resolve(targetRoot, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(resolve(sourceRoot, relativePath), targetPath);
}

await copyFile(
  resolve(root, 'src/apps/nekosearch/semantic-runtime-lock.json'),
  resolve(root, 'dist/apps/nekosearch/semantic-runtime-lock.json'),
);
