import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PACKAGE_DESCRIPTION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  packageMetadataSchema,
} from '../../apps/nekosearch/dist/apps/nekosearch/package-metadata.js';
import { validateSnapshotDirectory } from '../../apps/nekosearch/dist/apps/nekosearch/catalog.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export async function verifyPackage(
  root = resolve(repository, 'apps/nekosearch'),
  engine = resolve(repository, 'packages/documentation-engine'),
) {
  const packageMetadata = packageMetadataSchema.parse(
    JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
  );
  const engineMetadata = JSON.parse(
    await readFile(resolve(engine, 'package.json'), 'utf8'),
  );
  if (
    packageMetadata.name !== PACKAGE_NAME ||
    packageMetadata.version !== PACKAGE_VERSION ||
    packageMetadata.description !== PACKAGE_DESCRIPTION
  ) {
    throw new Error('npm package metadata does not match its runtime metadata');
  }

  const requiredFiles = [
    'dist/apps/nekosearch/cli.js',
    'dist/apps/nekosearch/mcp-command.js',
    'dist/apps/nekosearch/setup.js',
    'dist/apps/nekosearch/setup-clients.js',
    'dist/apps/nekosearch/catalog.js',
    'dist/apps/nekosearch/remote-snapshots.js',
    'dist/apps/nekosearch/serve.js',
    'dist/apps/nekosearch/build.js',
    'dist/apps/nekosearch/semantic-search.js',
    'dist/apps/nekosearch/embeddings.js',
    'dist/apps/nekosearch/sources/nestjs/documentation.integration.js',
    'dist/apps/nekosearch/sources/nestjs/github/documentation-source.js',
    'dist/apps/nekosearch/sources/nestjs/nestjs-documentation-transformer.js',
    'dist/apps/nekosearch/sources/nestjs/source-recipes.js',
    'dist/apps/nekosearch/sources/nestjs/version/documentation-version.js',
    'dist/apps/nekosearch/mcp/contracts/documentation-tools.contract.js',
    'dist/apps/nekosearch/mcp/documentation-tool-handlers.js',
    'dist/apps/nekosearch/mcp/presenters/documentation.presenter.js',
    'dist/apps/nekosearch/package-metadata.js',
  ];
  await Promise.all(
    requiredFiles.map((path) => requireFile(resolve(root, path))),
  );

  const files = packageMetadata.files ?? [];
  if (
    packageMetadata.private === true ||
    ['preinstall', 'install', 'postinstall'].some((hook) =>
      Object.hasOwn(packageMetadata.scripts ?? {}, hook),
    ) ||
    packageMetadata.bin?.nekosearch !== './dist/apps/nekosearch/cli.js' ||
    Object.keys(packageMetadata.bin ?? {}).length !== 1 ||
    packageMetadata.dependencies?.['@nestjs-docs/documentation-engine'] !==
      '0.1.0' ||
    !packageMetadata.bundleDependencies?.includes(
      '@nestjs-docs/documentation-engine',
    ) ||
    packageMetadata.dependencies?.['@modelcontextprotocol/server'] !==
      '^2.4.0' ||
    packageMetadata.dependencies?.json5 !== '^2.2.3' ||
    packageMetadata.dependencies?.['@huggingface/transformers'] !== undefined ||
    packageMetadata.peerDependencies?.['@huggingface/transformers'] !==
      '4.3.2' ||
    packageMetadata.peerDependenciesMeta?.['@huggingface/transformers']
      ?.optional !== true ||
    packageMetadata.files?.includes('dist/**') === true ||
    !files.includes('dist/apps/nekosearch/**') ||
    !files.includes('data/mcp-protocol/**') ||
    files.some((path) => /^data\/documentation-v(?:11|12)\./u.test(path)) ||
    files.includes('data/manifest.json')
  ) {
    throw new Error('npm package metadata or file allowlist is invalid');
  }
  if (
    Object.keys(packageMetadata.dependencies ?? {}).some((name) =>
      name.startsWith('@nestjs/'),
    ) ||
    Object.keys(engineMetadata.dependencies ?? {}).some((name) =>
      name.startsWith('@nestjs/'),
    ) ||
    ['reflect-metadata', 'rxjs'].some(
      (name) =>
        Object.hasOwn(packageMetadata.dependencies ?? {}, name) ||
        Object.hasOwn(engineMetadata.dependencies ?? {}, name),
    )
  ) {
    throw new Error(
      'The runtime package must not depend on NestJS framework packages',
    );
  }
  if (
    !engineMetadata.files?.includes(
      'dist/infrastructure/markdown/documentation-link-resolver.js',
    )
  ) {
    throw new Error(
      'The documentation engine package must include its internal link resolver',
    );
  }
  if (
    !engineMetadata.files?.includes(
      'dist/domain/documentation-embedding.schemas.js',
    ) ||
    !engineMetadata.files?.includes(
      'dist/infrastructure/sqlite/documentation-embeddings.js',
    )
  ) {
    throw new Error(
      'The documentation engine package must include its embedding schema and SQLite store',
    );
  }
  if (
    !engineMetadata.files?.includes(
      'dist/retrieval/fusion/reciprocal-rank-fusion.js',
    ) ||
    !engineMetadata.files?.includes(
      'dist/retrieval/retrievers/semantic-retriever.js',
    )
  ) {
    throw new Error(
      'The documentation engine package must include semantic retrieval and RRF',
    );
  }
  if (
    !engineMetadata.files?.includes(
      'dist/retrieval/documentation-input.error.js',
    )
  ) {
    throw new Error(
      'The documentation engine package must include its input error type',
    );
  }

  const protocolSnapshot = await validateSnapshotDirectory(
    resolve(root, 'data/mcp-protocol'),
  );
  if (
    protocolSnapshot.source !== 'mcp' ||
    protocolSnapshot.version !== '2025-11-25' ||
    protocolSnapshot.revision !== '2025-11-25'
  ) {
    throw new Error('Bundled MCP protocol snapshot identity is invalid');
  }

  const executable = await readFile(
    resolve(root, 'dist/apps/nekosearch/cli.js'),
    'utf8',
  );
  if (!executable.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('NekoSearch CLI entry point is not executable');
  }
  console.log('Verified generic NekoSearch package and MCP protocol snapshot.');
}

async function requireFile(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`Required package file is missing: ${path}`, {
      cause: error,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyPackage().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
