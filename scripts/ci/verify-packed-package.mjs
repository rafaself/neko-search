import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../../', import.meta.url));
const versions = ['11', '12'];
const officialNestSource = 'https://github.com/nestjs/docs.nestjs.com';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal})\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function withoutNpmDryRun(environment) {
  const clean = { ...environment };
  delete clean.npm_config_dry_run;
  delete clean.NPM_CONFIG_DRY_RUN;
  return clean;
}

function withoutIndexPathOverrides(environment) {
  const clean = { ...environment };
  delete clean.DOCUMENTATION_INDEX_PATH;
  delete clean.DOCUMENTATION_INDEX_MANIFEST_PATH;
  return clean;
}

async function withTimeout(promise, label, milliseconds = 30_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function createLocalNestSnapshot(snapshotDirectory, revisionOverride) {
  await mkdir(snapshotDirectory, { recursive: true });
  const sourceData = join(root, 'data');
  let database = await readFile(join(sourceData, 'documentation-v12.sqlite'));
  const corpusValue = JSON.parse(
    await readFile(join(sourceData, 'documentation-v12.json'), 'utf8'),
  );
  const runtimeManifest = JSON.parse(
    await readFile(join(sourceData, 'documentation-v12.manifest.json'), 'utf8'),
  );
  if (revisionOverride) {
    corpusValue.source.revision = revisionOverride;
    for (const document of corpusValue.documents) {
      document.source.provenance.revision = revisionOverride;
      for (const chunk of document.chunks) {
        chunk.sourceRevision = revisionOverride;
      }
    }
    runtimeManifest.source.revision = revisionOverride;
    runtimeManifest.index.sourceRevision = revisionOverride;
  }
  const parsedCorpus = corpusValue;
  const corpus = Buffer.from(`${JSON.stringify(parsedCorpus, null, 2)}\n`);
  await Promise.all([
    writeFile(join(snapshotDirectory, 'index.sqlite'), database),
    writeFile(join(snapshotDirectory, 'corpus.json'), corpus),
  ]);
  if (revisionOverride) {
    const databasePath = join(snapshotDirectory, 'index.sqlite');
    const index = new DatabaseSync(databasePath);
    try {
      index
        .prepare(
          'UPDATE documentation_search SET source_revision = ? WHERE documentation_version = ?',
        )
        .run(revisionOverride, '12');
      index
        .prepare(
          'UPDATE documentation_index_metadata SET value = ? WHERE key = ?',
        )
        .run(revisionOverride, 'source_revision');
    } finally {
      index.close();
    }
    database = await readFile(databasePath);
  }
  runtimeManifest.index.sha256 = sha256(database);

  const buildManifest = {
    manifestVersion: 2,
    documentation: { id: 'nestjs', version: '12' },
    source: parsedCorpus.source,
    pipeline: {
      parserVersion: 1,
      transformerVersion: 1,
      normalizationAlgorithmVersion: 1,
      chunkingAlgorithmVersion: 1,
      maxChunkChars: 4000,
      indexSchemaVersion: runtimeManifest.index.schemaVersion,
      indexFormatVersion: runtimeManifest.index.formatVersion,
    },
    corpus: {
      file: 'corpus.json',
      sha256: sha256(corpus),
      documentCount: parsedCorpus.documents.length,
      documents: [...parsedCorpus.documents]
        .sort((left, right) =>
          compareStrings(left.source.path, right.source.path),
        )
        .map((document) => ({
          id: document.id,
          path: document.source.path,
          sourceContentHash: document.source.contentHash,
          normalizedContentHash: document.contentHash,
        })),
    },
    index: {
      ...runtimeManifest.index,
      file: 'index.sqlite',
      sha256: sha256(database),
    },
  };
  await writeFile(
    join(snapshotDirectory, 'manifest.json'),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
  );
}

async function verifyCatalogServer(project, temporaryDirectory) {
  const binary = join(project, 'node_modules', '.bin', 'nekosearch');
  const guardPath = join(project, 'network-guard.mjs');
  const networkMarker = join(project, 'network-blocked');
  const mdxExecutionMarker = join(project, 'mdx-executed');
  const xdgDataHome = join(project, 'xdg-data');
  const fixtureDirectory = join(temporaryDirectory, 'minha-api-docs');
  const fixtureSnapshotDirectory = join(
    temporaryDirectory,
    'minha-api-snapshot',
  );
  const snapshotDirectory = join(temporaryDirectory, 'local-nest-v12');
  await mkdir(xdgDataHome);
  await mkdir(fixtureDirectory);
  await writeFile(
    join(fixtureDirectory, 'index.md'),
    '# Minha API\n\nA busca local preserva tokens de mandacaru no contexto.\n',
  );
  await writeFile(
    join(fixtureDirectory, 'guide.mdx'),
    [
      '---',
      'title: Guia de MDX',
      '---',
      '',
      '# Guia de MDX',
      '',
      '<Callout type="note">Jabuticaba e mandacaru aparecem no guia estático.</Callout>',
      '',
      '{globalThis.__nekosearchMdxExecuted = true}',
      '',
    ].join('\n'),
  );
  const catalogDirectory = join(xdgDataHome, 'nekosearch');
  const catalogFile = join(catalogDirectory, 'catalog.json');
  const guardedEnvironment = withoutIndexPathOverrides({
    ...process.env,
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
    NEKOSEARCH_NETWORK_GUARD_MARKER: networkMarker,
    NEKOSEARCH_MDX_EXECUTION_MARKER: mdxExecutionMarker,
    XDG_DATA_HOME: xdgDataHome,
  });

  const buildOutput = run(
    binary,
    [
      'build',
      fixtureDirectory,
      '--id',
      'minha-api@1',
      '--output',
      fixtureSnapshotDirectory,
    ],
    { cwd: project, env: guardedEnvironment },
  );
  assert.equal(
    buildOutput,
    '',
    'build should keep stdout available to callers',
  );
  assert.deepEqual((await readdir(fixtureSnapshotDirectory)).sort(), [
    'corpus.json',
    'index.sqlite',
    'manifest.json',
  ]);
  await assert.rejects(readFile(catalogFile), { code: 'ENOENT' });
  await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(mdxExecutionMarker), { code: 'ENOENT' });

  const fixtureAdded = run(
    binary,
    ['add', '--from', fixtureSnapshotDirectory],
    { cwd: project, env: guardedEnvironment },
  );
  assert.match(fixtureAdded, /Added minha-api@1 revision /u);

  await createLocalNestSnapshot(snapshotDirectory);
  const added = run(binary, ['add', '--from', snapshotDirectory], {
    cwd: project,
    env: guardedEnvironment,
  });
  assert.match(added, /Added nestjs@12 revision /u);
  const updatedRevision = 'f'.repeat(40);
  const updatedSnapshotDirectory = join(
    temporaryDirectory,
    'local-nest-v12-updated',
  );
  await createLocalNestSnapshot(updatedSnapshotDirectory, updatedRevision);
  const { updateSnapshot } = await import(
    pathToFileURL(join(root, 'dist/apps/nekosearch/catalog.js')).href
  );
  const update = await updateSnapshot(updatedSnapshotDirectory, {
    catalogRoot: join(xdgDataHome, 'nekosearch'),
  });
  assert.equal(update.changed, true);
  assert.equal(update.entry.revision, updatedRevision);
  const catalogOutput = run(binary, ['list'], {
    cwd: project,
    env: guardedEnvironment,
  });
  const rows = new Map(
    catalogOutput
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const [source, version, revision, status] = line.split('\t');
        return [`${source}@${version}`, { source, version, revision, status }];
      }),
  );
  assert.deepEqual(rows.get('mcp@2025-11-25'), {
    source: 'mcp',
    version: '2025-11-25',
    revision: '2025-11-25',
    status: 'bundled',
  });
  assert.equal(rows.get(`${officialNestSource}@11`)?.status, 'bundled');
  assert.equal(rows.get(`${officialNestSource}@12`)?.status, 'bundled');
  assert.match(rows.get('nestjs@12')?.revision ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(rows.get('nestjs@12')?.status, 'installed');
  assert.equal(rows.get('nestjs@12')?.revision, updatedRevision);
  assert.match(rows.get('minha-api@1')?.revision ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(rows.get('minha-api@1')?.status, 'installed');
  assert.equal(
    rows.size,
    5,
    'the catalog should show all bundled and installed indexes',
  );

  const installedPackage = join(project, 'node_modules', 'nestjs-docs-mcp');
  const catalogRegistry = JSON.parse(
    await readFile(join(xdgDataHome, 'nekosearch', 'catalog.json'), 'utf8'),
  );
  const installedSnapshotKey = catalogRegistry.snapshots.find(
    (snapshot) => snapshot.source === 'nestjs' && snapshot.version === '12',
  )?.directoryKey;
  assert.match(installedSnapshotKey ?? '', /^[a-f0-9]{64}$/u);
  const fixtureSnapshotKey = catalogRegistry.snapshots.find(
    (snapshot) => snapshot.source === 'minha-api' && snapshot.version === '1',
  )?.directoryKey;
  assert.match(fixtureSnapshotKey ?? '', /^[a-f0-9]{64}$/u);
  const indexPaths = [
    join(installedPackage, 'data', 'mcp-protocol', 'index.sqlite'),
    join(installedPackage, 'data', 'documentation-v11.sqlite'),
    join(installedPackage, 'data', 'documentation-v12.sqlite'),
    join(
      xdgDataHome,
      'nekosearch',
      'snapshots',
      installedSnapshotKey,
      'index.sqlite',
    ),
    join(
      xdgDataHome,
      'nekosearch',
      'snapshots',
      fixtureSnapshotKey,
      'index.sqlite',
    ),
  ];
  const indexHashes = await Promise.all(
    indexPaths.map(async (path) => sha256(await readFile(path))),
  );

  const transport = new StdioClientTransport({
    command: binary,
    args: ['serve'],
    cwd: project,
    env: guardedEnvironment,
    stderr: 'pipe',
  });
  const transportErrors = [];
  const stderr = [];
  let stdout = '';
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    transport._process?.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
  };
  transport.onerror = (error) => transportErrors.push(error);
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));
  const client = new Client({
    name: 'nekosearch-package-smoke',
    version: '1.0.0',
  });
  let child;
  try {
    await withTimeout(client.connect(transport), 'NekoSearch initialize').catch(
      (error) => {
        throw new Error(
          `NekoSearch initialize failed; stderr: ${stderr.join('')}; exit code: ${transport._process?.exitCode}`,
          { cause: error },
        );
      },
    );
    child = transport._process;
    assert.ok(transport.pid, 'the installed executable did not start');

    const tools = await withTimeout(client.listTools(), 'NekoSearch listTools');
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['fetch_docs', 'search_docs'],
      'the server must expose search_docs and fetch_docs',
    );
    const searchTool = tools.tools.find((tool) => tool.name === 'search_docs');
    const fetchTool = tools.tools.find((tool) => tool.name === 'fetch_docs');
    assert.deepEqual(
      Object.keys(searchTool.inputSchema.properties).sort(),
      ['limit', 'query', 'source', 'version'],
      'search_docs must expose selectors and no filesystem paths',
    );
    assert.deepEqual(
      Object.keys(fetchTool.inputSchema.properties).sort(),
      ['cursor', 'documentId', 'sectionId', 'source', 'version'],
      'fetch_docs must expose selectors and no filesystem paths',
    );

    const protocolSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          source: 'mcp',
          version: '2025-11-25',
          query: 'JSON-RPC messages',
          limit: 3,
        },
      }),
      'MCP protocol search_docs',
    );
    assert.ok(!protocolSearch.isError, 'MCP protocol search should succeed');
    const protocolData = protocolSearch.structuredContent;
    assert.equal(protocolData.source, 'mcp');
    assert.equal(protocolData.version, '2025-11-25');
    assert.equal(protocolData.revision, '2025-11-25');
    assert.ok(protocolData.results.length > 0);
    const protocolHit = protocolData.results[0];
    assert.equal(protocolHit.source, protocolData.source);
    assert.equal(protocolHit.version, protocolData.version);
    assert.match(
      protocolHit.canonicalUrl,
      /^https:\/\/modelcontextprotocol\.io\//u,
    );

    const localNestSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          source: 'nestjs',
          version: '12',
          query: 'ExecutionContext',
          limit: 3,
        },
      }),
      'installed NestJS search_docs',
    );
    assert.ok(
      !localNestSearch.isError,
      'installed NestJS search should succeed',
    );
    const localNestData = localNestSearch.structuredContent;
    assert.equal(localNestData.source, 'nestjs');
    assert.equal(localNestData.version, '12');
    assert.equal(localNestData.revision, rows.get('nestjs@12')?.revision);
    assert.ok(localNestData.results.length > 0);
    const localNestHit = localNestData.results[0];
    assert.match(localNestHit.documentId, /^nestjs-doc:v12:/u);
    assert.equal(localNestHit.source, 'nestjs');
    assert.equal(localNestHit.version, '12');
    assert.match(localNestHit.canonicalUrl, /^https:\/\/docs\.nestjs\.com\//u);

    const localFixtureSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          source: 'minha-api',
          version: '1',
          query: 'mandacaru',
          limit: 3,
        },
      }),
      'installed local fixture search_docs',
    );
    assert.ok(!localFixtureSearch.isError);
    const localFixtureData = localFixtureSearch.structuredContent;
    assert.equal(localFixtureData.source, 'minha-api');
    assert.equal(localFixtureData.version, '1');
    assert.equal(localFixtureData.documentationId, 'minha-api');
    assert.equal(localFixtureData.documentationVersion, '1');
    assert.match(localFixtureData.revision, /^[a-f0-9]{64}$/u);
    assert.ok(localFixtureData.results.length > 0);
    const localFixtureHit = localFixtureData.results[0];
    assert.equal(localFixtureHit.source, 'minha-api');
    assert.equal(localFixtureHit.version, '1');
    assert.match(localFixtureHit.canonicalUrl, /^https:\/\/docs\.example\//u);
    assert.ok(
      localFixtureData.results.some((result) =>
        result.excerpt.includes('mandacaru'),
      ),
    );

    for (const [sourceData, hit] of [
      [protocolData, protocolHit],
      [localNestData, localNestHit],
      [localFixtureData, localFixtureHit],
    ]) {
      assert.ok(
        sourceData.results.every(
          (result) =>
            result.source === sourceData.source &&
            result.version === sourceData.version,
        ),
        'each search response must contain results from only the selected index',
      );
      const fetched = await withTimeout(
        client.callTool({
          name: 'fetch_docs',
          arguments: {
            source: hit.source,
            version: hit.version,
            documentId: hit.documentId,
            sectionId: hit.chunkId,
          },
        }),
        `${sourceData.source}@${sourceData.version} fetch_docs`,
      );
      assert.ok(!fetched.isError, 'fetch_docs should succeed');
      const document = fetched.structuredContent;
      assert.equal(document.source, sourceData.source);
      assert.equal(document.version, sourceData.version);
      assert.equal(document.revision, sourceData.revision);
      assert.equal(document.documentationId, sourceData.documentationId);
      assert.equal(
        document.documentationVersion,
        sourceData.documentationVersion,
      );
      assert.equal(document.found, true);
      assert.equal(document.sourceRevision, hit.sourceRevision);
      assert.ok(document.sections.length > 0);
    }

    const bundledNestSearch = await withTimeout(
      client.callTool({
        name: 'search_docs',
        arguments: {
          source: officialNestSource,
          version: '11',
          query: 'ExecutionContext',
          limit: 1,
        },
      }),
      'bundled NestJS v11 search_docs',
    );
    assert.ok(!bundledNestSearch.isError);
    assert.equal(bundledNestSearch.structuredContent.version, '11');
    assert.ok(bundledNestSearch.structuredContent.results.length > 0);

    assert.deepEqual(
      transportErrors,
      [],
      'stdout must remain valid MCP protocol',
    );
    await client.close();
    await withTimeout(waitForClose(child), 'NekoSearch graceful shutdown');
    assert.equal(child.exitCode, 0, 'the server should exit cleanly');
    assert.equal(child.signalCode, null);
    assert.match(stderr.join(''), /NekoSearch MCP server ready on stdio/u);
    assertProtocolStdout(stdout);
    assert.doesNotMatch(stderr.join(''), /NETWORK_BLOCKED/u);
    await assert.rejects(readFile(networkMarker), { code: 'ENOENT' });
    assert.deepEqual(
      await Promise.all(
        indexPaths.map(async (path) => sha256(await readFile(path))),
      ),
      indexHashes,
      'serving the catalog must leave bundled and installed SQLite indexes unchanged',
    );
    console.log('Verified installed NekoSearch catalog and stdio server');
  } finally {
    child ??= transport._process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForClose(child);
    }
    await client.close().catch(() => {});
  }
}

function assertProtocolStdout(stdout) {
  const lines = stdout.trim().split('\n');
  assert.ok(
    lines.length > 0 && lines[0],
    'MCP protocol stdout should not be empty',
  );
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.ok(
      typeof message.method === 'string' ||
        typeof message.id === 'number' ||
        typeof message.id === 'string',
      'stdout must contain only MCP protocol messages',
    );
  }
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveClose) => child.once('close', resolveClose));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'nestjs-docs-packed-package-'),
  );
  const npmEnvironment = {
    ...withoutNpmDryRun(process.env),
    npm_config_cache: join(temporaryDirectory, 'npm-cache'),
  };
  try {
    const packDirectory = join(temporaryDirectory, 'packed');
    const project = join(temporaryDirectory, 'isolated-project');
    await Promise.all([mkdir(packDirectory), mkdir(project)]);

    const packed = JSON.parse(
      run(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          packDirectory,
        ],
        { env: npmEnvironment },
      ),
    );
    assert.equal(packed.length, 1, 'npm pack should produce one tarball');
    const files = new Set(packed[0].files.map((file) => file.path));
    for (const path of [
      'data/documentation-v11.sqlite',
      'data/documentation-v11.manifest.json',
      'data/documentation-v12.sqlite',
      'data/documentation-v12.manifest.json',
      'data/manifest.json',
      'data/mcp-protocol/corpus.json',
      'data/mcp-protocol/index.sqlite',
      'data/mcp-protocol/manifest.json',
      'README.md',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'licenses/nestjs-docs-v11-LICENSE',
      'licenses/nestjs-docs-v12-LICENSE',
      'dist/apps/nekosearch/cli.js',
      'dist/apps/nekosearch/serve.js',
      'dist/apps/nekosearch/build.js',
      'dist/apps/nekosearch/build-runtime/config/documentation-build-config.js',
      'dist/apps/nekosearch/build-runtime/services/build-documentation-snapshot.js',
      'dist/apps/nekosearch/build-runtime/services/build-local-documentation.js',
      'dist/apps/nekosearch/catalog.js',
      'dist/apps/nekosearch/remote-snapshots.js',
      'dist/apps/nekosearch/catalog-contract.js',
      'dist/modules/documentation/mcp/contracts/documentation-tools.contract.js',
      'dist/modules/documentation/mcp/documentation-tool-handlers.js',
      'dist/modules/documentation/mcp/presenters/documentation.presenter.js',
      'dist/shared/config/package-metadata.js',
      'node_modules/@nestjs-docs/documentation-engine/package.json',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/sqlite-documentation-store.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/runtime-index.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/application/services/documentation-ingestion.service.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/documentation-discovery.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/document-normalizer.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/markdown-parser.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-corpus.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-integrity.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-writer.js',
    ]) {
      assert.ok(files.has(path), `the npm tarball must include ${path}`);
    }
    for (const version of versions) {
      assert.ok(
        !files.has(`data/documentation-v${version}.json`),
        'the npm tarball should omit NestJS corpus files after package validation',
      );
    }
    const buildRuntimeFiles = new Set([
      'dist/apps/nekosearch/build-runtime/config/documentation-build-config.js',
      'dist/apps/nekosearch/build-runtime/services/build-documentation-snapshot.js',
      'dist/apps/nekosearch/build-runtime/services/build-local-documentation.js',
    ]);
    const buildEngineFiles = new Set([
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/document-normalizer.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/markdown-parser.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/documentation-discovery.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-corpus.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-integrity.js',
      'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/index-writer.js',
    ]);
    for (const path of files) {
      assert.ok(
        !path.startsWith('dist/apps/mcp-server/') &&
          !path.startsWith('dist/apps/docs-indexer/') &&
          (!path.startsWith('dist/apps/nekosearch/build-runtime/') ||
            buildRuntimeFiles.has(path)) &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/markdown/',
          ) ||
            buildEngineFiles.has(path)) &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/filesystem/',
          ) ||
            buildEngineFiles.has(path)) &&
          (!path.startsWith(
            'node_modules/@nestjs-docs/documentation-engine/dist/infrastructure/sqlite/indexing/',
          ) ||
            buildEngineFiles.has(path)) &&
          !path.endsWith('/documentation.tools.js') &&
          !path.endsWith('/documentation-mcp.module.js'),
        `the npm tarball should exclude HTTP and build-only code: ${path}`,
      );
    }
    for (const path of files) {
      assert.ok(
        !path.startsWith('apps/docs-indexer/') &&
          !path.startsWith('packages/documentation-engine/') &&
          !path.startsWith('test/'),
        `the npm tarball should not expose workspace sources: ${path}`,
      );
    }
    const tarballPath = resolve(packDirectory, packed[0].filename);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'nestjs-docs-mcp-package-smoke',
        version: '1.0.0',
        private: true,
        dependencies: {
          'nestjs-docs-mcp': `file:${tarballPath}`,
        },
      }),
    );
    const networkGuard = `import * as net from 'node:net';
import tls from 'node:tls';
import * as dgram from 'node:dgram';
import { writeFileSync } from 'node:fs';
function block(operation) {
  const marker = process.env.NEKOSEARCH_NETWORK_GUARD_MARKER;
  if (marker) writeFileSync(marker, operation);
  throw new Error('NETWORK_BLOCKED: ' + operation);
}
net.Server.prototype.listen = function () { return block('net.Server.listen'); };
net.Socket.prototype.connect = function () { return block('net.Socket.connect'); };
tls.connect = function () { return block('tls.connect'); };
dgram.Socket.prototype.bind = function () { return block('dgram.Socket.bind'); };
globalThis.fetch = function () {
  const marker = process.env.NEKOSEARCH_NETWORK_GUARD_MARKER;
  if (marker) writeFileSync(marker, 'fetch');
  return Promise.reject(new Error('NETWORK_BLOCKED: fetch'));
};
process.once('exit', () => {
  const marker = process.env.NEKOSEARCH_MDX_EXECUTION_MARKER;
  if (marker && globalThis.__nekosearchMdxExecuted) {
    writeFileSync(marker, 'executed');
  }
});
`;
    const guardPath = join(project, 'network-guard.mjs');
    await writeFile(guardPath, networkGuard);
    run(
      'npm',
      [
        'install',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
      ],
      { cwd: project, env: npmEnvironment },
    );

    const installedPackage = join(project, 'node_modules', 'nestjs-docs-mcp');
    const [cliSource, serveSource, remoteSnapshotSource, buildSource] =
      await Promise.all([
        readFile(join(installedPackage, 'dist/apps/nekosearch/cli.js'), 'utf8'),
        readFile(
          join(installedPackage, 'dist/apps/nekosearch/serve.js'),
          'utf8',
        ),
        readFile(
          join(installedPackage, 'dist/apps/nekosearch/remote-snapshots.js'),
          'utf8',
        ),
        readFile(
          join(installedPackage, 'dist/apps/nekosearch/build.js'),
          'utf8',
        ),
      ]);
    assert.match(cliSource, /import\('\.\/remote-snapshots\.js'\)/u);
    assert.match(cliSource, /import\('\.\/build\.js'\)/u);
    assert.doesNotMatch(cliSource, /^import .*remote-snapshots/mu);
    assert.doesNotMatch(cliSource, /^import .*build\.js/mu);
    assert.doesNotMatch(
      serveSource,
      /remote-snapshots|markdown-parser|document-normalizer|docs-indexer|build-runtime/u,
    );
    assert.doesNotMatch(
      remoteSnapshotSource,
      /markdown-parser|document-normalizer|docs-indexer/u,
    );
    assert.match(
      buildSource,
      /build-runtime\/services\/build-local-documentation\.js/u,
    );
    assert.doesNotMatch(buildSource, /@mdx-js\/mdx|remark-gfm/u);
    const installedEngine = join(
      installedPackage,
      'node_modules',
      '@nestjs-docs',
      'documentation-engine',
    );
    await readFile(join(installedEngine, 'package.json'));
    for (const runtimePath of [
      'dist/infrastructure/sqlite/sqlite-documentation-store.js',
      'dist/infrastructure/sqlite/runtime-index.js',
      'dist/domain/documentation.schemas.js',
      'dist/infrastructure/markdown/markdown-parser.js',
      'dist/infrastructure/markdown/document-normalizer.js',
      'dist/infrastructure/filesystem/documentation-discovery.js',
      'dist/infrastructure/sqlite/indexing/index-writer.js',
      'dist/infrastructure/sqlite/indexing/index-integrity.js',
      'dist/infrastructure/sqlite/indexing/index-corpus.js',
      'dist/application/services/documentation-ingestion.service.js',
    ]) {
      await readFile(join(installedEngine, runtimePath));
    }
    const dependencyTree = JSON.parse(
      run('npm', ['ls', '--all', '--omit=dev', '--json'], {
        cwd: project,
        env: npmEnvironment,
      }),
    );
    const installedDependencyNames = collectDependencyNames(dependencyTree);
    for (const excludedPackage of [
      '@nestjs/core',
      '@nestjs/mcp',
      '@nestjs/platform-express',
      '@modelcontextprotocol/client',
      'eventsource',
      'eventsource-parser',
      'express',
      'json5',
      'jest',
      'typescript',
      '@nestjs/cli',
      'eslint',
    ]) {
      assert.ok(
        !installedDependencyNames.has(excludedPackage),
        `${excludedPackage} must be absent from the production dependency tree`,
      );
    }
    for (const requiredBuildDependency of ['@mdx-js/mdx', 'remark-gfm']) {
      assert.ok(
        installedDependencyNames.has(requiredBuildDependency),
        `${requiredBuildDependency} must be installed for the offline build command`,
      );
    }
    for (const developmentOnlyPackage of [
      'typescript',
      'jest',
      '@nestjs/cli',
      '@modelcontextprotocol/client',
    ]) {
      try {
        await readFile(
          join(project, 'node_modules', developmentOnlyPackage, 'package.json'),
        );
        throw new Error(
          `${developmentOnlyPackage} was installed in the production-only project`,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    await verifyCatalogServer(project, temporaryDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function collectDependencyNames(tree, names = new Set()) {
  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    names.add(name);
    collectDependencyNames(dependency, names);
  }
  return names;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
