import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  addSnapshot,
  listCatalogIndexes,
  removeSnapshot,
} from '../../../../src/apps/nekosearch/catalog.js';
import { createDocumentationTestIndex } from '../../../fixtures/documentation-index.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';

describe('NekoSearch snapshot catalog', () => {
  let root: string;
  let snapshotDirectory: string;
  let catalogRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-catalog-'));
    snapshotDirectory = join(root, 'snapshot');
    catalogRoot = join(root, 'catalog');
    mkdirSync(snapshotDirectory);
    createDocumentationTestIndex(join(snapshotDirectory, 'index.sqlite'), '12');
    const manifestPath = join(snapshotDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      documentation: { id: string };
      index: { file: string };
    };
    manifest.documentation.id = 'nestjs';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds a validated snapshot and lists its identity and installed status', async () => {
    const added = await addSnapshot(snapshotDirectory, { catalogRoot });
    expect(added).toMatchObject({
      source: 'nestjs',
      version: '12',
      revision: 'mcp-synthetic-revision',
      status: 'installed',
    });
    expect(lstatSync(added.databasePath).isFile()).toBe(true);

    const entries = await listCatalogIndexes({ catalogRoot });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'mcp',
          version: '2025-11-25',
          status: 'bundled',
        }),
        expect.objectContaining({
          source: 'nestjs',
          version: '12',
          revision: 'mcp-synthetic-revision',
          status: 'installed',
        }),
      ]),
    );
  });

  it('ignores an unregistered content-addressed snapshot during activation', async () => {
    await addSnapshot(snapshotDirectory, { catalogRoot });

    // Activation renames the validated directory before atomically writing
    // its registry pointer. Model a reader observing that interval.
    rmSync(join(catalogRoot, 'catalog.json'));

    const entries = await listCatalogIndexes({ catalogRoot });
    expect(
      entries.map(({ source, version }) => `${source}@${version}`),
    ).toEqual(['mcp@2025-11-25']);
  });

  it('removes an installed snapshot while preserving other entries and open readers', async () => {
    const added = await addSnapshot(snapshotDirectory, { catalogRoot });
    const otherSnapshot = join(root, 'other-snapshot');
    mkdirSync(otherSnapshot);
    createDocumentationTestIndex(join(otherSnapshot, 'index.sqlite'), '1', {
      documentationId: 'fastapi',
      revision: 'fastapi-synthetic-revision',
    });
    await addSnapshot(otherSnapshot, { catalogRoot });

    const reader = new TestDocumentationSearchService(added.databasePath, '12');
    try {
      const removed = await removeSnapshot('nestjs@12', { catalogRoot });

      expect(removed.entry).toMatchObject({
        source: 'nestjs',
        version: '12',
        status: 'installed',
      });
      expect(removed.cleanupWarning).toBeUndefined();
      expect(existsSync(dirname(added.databasePath))).toBe(false);
      expect(reader.search('ExecutionContext')).toHaveLength(1);

      const entries = await listCatalogIndexes({ catalogRoot });
      expect(
        entries.map(({ source, version }) => `${source}@${version}`),
      ).toEqual(['fastapi@1', 'mcp@2025-11-25']);
    } finally {
      reader.close();
    }
  });

  it('rejects unknown and bundled selectors without changing the catalog', async () => {
    await expect(removeSnapshot('missing@1', { catalogRoot })).rejects.toThrow(
      'No installed snapshot exists for missing@1',
    );
    await expect(
      removeSnapshot('mcp@2025-11-25', { catalogRoot }),
    ).rejects.toThrow('Cannot remove bundled snapshot mcp@2025-11-25');
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('accepts the source selector through the public CLI command', async () => {
    const dataHome = join(root, 'cli-data');
    const cliCatalogRoot = join(dataHome, 'nekosearch');
    await addSnapshot(snapshotDirectory, { catalogRoot: cliCatalogRoot });

    const output = execFileSync(
      process.execPath,
      [
        resolve(process.cwd(), 'dist/apps/nekosearch/cli.js'),
        'remove',
        'nestjs@12',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          LOCALAPPDATA: dataHome,
          XDG_DATA_HOME: dataHome,
        },
      },
    );

    expect(output).toContain(
      'Removed nestjs@12 revision mcp-synthetic-revision',
    );
    expect(
      (await listCatalogIndexes({ catalogRoot: cliCatalogRoot })).map(
        ({ source, version }) => `${source}@${version}`,
      ),
    ).toEqual(['mcp@2025-11-25']);
  });

  it('rejects a corpus hash mismatch before creating the catalog', async () => {
    writeFileSync(join(snapshotDirectory, 'corpus.json'), '{"version":"12"}\n');

    await expect(
      addSnapshot(snapshotDirectory, { catalogRoot }),
    ).rejects.toThrow(/corpus|hash|format/iu);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects manifest paths that escape the snapshot directory before writing', async () => {
    const manifestPath = join(snapshotDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      documentation: { id: string };
      index: { file: string };
    };
    manifest.index.file = '../outside.sqlite';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(
      addSnapshot(snapshotDirectory, { catalogRoot }),
    ).rejects.toThrow(/manifest|format/iu);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects symlinked snapshot files before writing to the catalog', async () => {
    const externalCorpus = join(root, 'external-corpus.json');
    const corpus = readFileSync(join(snapshotDirectory, 'corpus.json'));
    writeFileSync(externalCorpus, corpus);
    rmSync(join(snapshotDirectory, 'corpus.json'));
    symlinkSync(externalCorpus, join(snapshotDirectory, 'corpus.json'));

    await expect(
      addSnapshot(snapshotDirectory, { catalogRoot }),
    ).rejects.toThrow(/safe regular file|unsafe/iu);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects a symlinked snapshot directory before writing to the catalog', async () => {
    const symlinkedDirectory = join(root, 'snapshot-link');
    symlinkSync(snapshotDirectory, symlinkedDirectory, 'dir');

    await expect(
      addSnapshot(symlinkedDirectory, { catalogRoot }),
    ).rejects.toThrow(/real directory/iu);
    expect(existsSync(catalogRoot)).toBe(false);
  });
});
