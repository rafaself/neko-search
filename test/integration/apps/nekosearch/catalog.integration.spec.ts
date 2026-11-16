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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSnapshot,
  listCatalogIndexes,
} from '../../../../src/apps/nekosearch/catalog.js';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';

describe('NekoSearch snapshot catalog', () => {
  let root: string;
  let snapshotDirectory: string;
  let catalogRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-catalog-'));
    snapshotDirectory = join(root, 'snapshot');
    catalogRoot = join(root, 'catalog');
    mkdirSync(snapshotDirectory);
    createMcpServerTestIndex(join(snapshotDirectory, 'index.sqlite'), '12');
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
