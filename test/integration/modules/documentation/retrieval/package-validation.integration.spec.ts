import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve('.');
const verifierModulePath = pathToFileURL(
  resolve(repositoryRoot, 'scripts/ci/verify-package.mjs'),
).href;
const importVerifier = (specifier: string) =>
  import(specifier) as Promise<{
    verifyPackage(root: string, engine: string): Promise<void>;
  }>;

let verifyPackage: (root: string) => Promise<void>;

describe('npm package verification', () => {
  let root: string;

  beforeAll(async () => {
    const verifier = await importVerifier(verifierModulePath);
    verifyPackage = (directory) =>
      verifier.verifyPackage(
        directory,
        join(directory, 'packages/documentation-engine'),
      );
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-package-'));
    cpSync(
      join(repositoryRoot, 'apps/nekosearch/data/mcp-protocol'),
      join(root, 'data/mcp-protocol'),
      { recursive: true },
    );
    copyFileSync(
      join(repositoryRoot, 'apps/nekosearch/package.json'),
      join(root, 'package.json'),
    );
    const engineMetadataPath = join(
      root,
      'packages/documentation-engine/package.json',
    );
    mkdirSync(dirname(engineMetadataPath), { recursive: true });
    copyFileSync(
      join(repositoryRoot, 'packages/documentation-engine/package.json'),
      engineMetadataPath,
    );

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
    for (const path of requiredFiles) {
      const absolutePath = join(root, path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(
        absolutePath,
        path.endsWith('/cli.js') ? '#!/usr/bin/env node\n' : '',
      );
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts the generic package with only the bundled MCP protocol snapshot', async () => {
    await expect(verifyPackage(root)).resolves.toBeUndefined();
  });

  it('rejects NestJS index assets in the npm file allowlist', async () => {
    const packagePath = join(root, 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      files: string[];
    };
    packageMetadata.files.push('data/documentation-v12.sqlite');
    writeFileSync(packagePath, JSON.stringify(packageMetadata));

    await expect(verifyPackage(root)).rejects.toThrow(
      'npm package metadata or file allowlist is invalid',
    );
  });

  it('rejects package metadata that differs from runtime metadata', async () => {
    const packagePath = join(root, 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      description: string;
    };
    packageMetadata.description = 'NestJS indexes bundled by default';
    writeFileSync(packagePath, JSON.stringify(packageMetadata));

    await expect(verifyPackage(root)).rejects.toThrow(
      'npm package metadata does not match its runtime metadata',
    );
  });

  it('rejects NestJS framework dependencies in the runtime manifests', async () => {
    const packagePath = join(root, 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    packageMetadata.dependencies['@nestjs/common'] = '^12.0.0';
    writeFileSync(packagePath, JSON.stringify(packageMetadata));

    await expect(verifyPackage(root)).rejects.toThrow(
      'The runtime package must not depend on NestJS framework packages',
    );
  });

  it('keeps the Transformers.js runtime optional for lexical-only installs', async () => {
    const packagePath = join(root, 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    packageMetadata.dependencies['@huggingface/transformers'] = '4.3.2';
    writeFileSync(packagePath, JSON.stringify(packageMetadata));

    await expect(verifyPackage(root)).rejects.toThrow(
      'npm package metadata or file allowlist is invalid',
    );
  });

  it('requires the on-demand NestJS source builder in the package runtime', async () => {
    rmSync(join(root, 'dist/apps/nekosearch/sources/nestjs/source-recipes.js'));

    await expect(verifyPackage(root)).rejects.toThrow('source-recipes.js');
  });
});
