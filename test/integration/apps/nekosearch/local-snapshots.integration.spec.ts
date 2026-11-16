import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLocalDocumentation } from '../../../../apps/docs-indexer/src/services/build-local-documentation.js';
import {
  getCatalogIndex,
  listCatalogIndexes,
} from '../../../../src/apps/nekosearch/catalog.js';
import {
  installLocalSnapshot,
  type LocalDocumentationSnapshotBuilder,
} from '../../../../src/apps/nekosearch/local-snapshots.js';
import {
  listCatalogDocumentation,
  searchCatalogDocumentation,
  type SearchableCatalogRuntime,
} from '../../../../src/apps/nekosearch/serve.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';

const packageDataDirectory = resolve(process.cwd(), 'data');

describe('NekoSearch local directory installs', () => {
  let root: string;
  let docsDirectory: string;
  let catalogRoot: string;
  let originalFetch: typeof fetch;
  let fetchRequests: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-local-add-'));
    docsDirectory = join(root, 'docs');
    catalogRoot = join(root, 'catalog');
    mkdirSync(docsDirectory);
    writeFileSync(
      join(docsDirectory, 'guide.mdx'),
      [
        '# Offline fixture',
        '',
        'Dependency injection uses container bindings for local queries.',
        '',
        '{globalThis.__nekosearchMdxExecuted = true}',
        '',
      ].join('\n'),
    );
    Reflect.deleteProperty(globalThis, '__nekosearchMdxExecuted');
    originalFetch = globalThis.fetch;
    fetchRequests = [];
    globalThis.fetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchRequests.push(url);
      return Promise.reject(new Error(`Unexpected network request: ${url}`));
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, '__nekosearchMdxExecuted');
    rmSync(root, { recursive: true, force: true });
  });

  it('builds and installs an MDX fixture for offline discovery and search', async () => {
    const stagingDirectories: string[] = [];
    let stagingMode = 0;
    const installed = await installLocalSnapshot(
      docsDirectory,
      'local-api@1',
      installOptions((input, selector, output) => {
        stagingDirectories.push(output);
        stagingMode = lstatSync(output).mode & 0o777;
        return buildFixture(input, selector, output);
      }),
    );

    expect(installed).toMatchObject({
      source: 'local-api',
      version: '1',
      status: 'installed',
      manifest: { source: { kind: 'local' } },
    });
    expect(lstatSync(installed.databasePath).isFile()).toBe(true);
    expect(stagingDirectories).toHaveLength(1);
    expect(stagingMode).toBe(0o700);
    expect(existsSync(stagingDirectories[0]!)).toBe(false);
    expect(Reflect.get(globalThis, '__nekosearchMdxExecuted')).toBeUndefined();
    expect(fetchRequests).toEqual([]);

    const available = await listCatalogIndexes({
      catalogRoot,
      packageDataDirectory,
    });
    expect(
      available.map(({ source, version }) => `${source}@${version}`),
    ).toContain('local-api@1');
    const entry = await getCatalogIndex('local-api@1', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(entry).toBeDefined();

    const documentation = new TestDocumentationSearchService(
      entry!.databasePath,
      entry!.version,
    );
    try {
      const runtime: SearchableCatalogRuntime = {
        entry: {
          source: entry!.source,
          version: entry!.version,
          revision: entry!.revision,
        },
        documentation,
      };
      const discovered = listCatalogDocumentation([runtime]);
      expect(discovered.structuredContent.sources).toEqual([
        {
          selector: 'local-api@1',
          source: 'local-api',
          version: '1',
          revision: entry!.revision,
        },
      ]);
      expect(JSON.stringify(discovered)).not.toContain(installed.databasePath);
      const search = searchCatalogDocumentation(
        new Map([['local-api@1', runtime]]),
        { query: 'container bindings', sources: ['local-api@1'] },
      );
      expect(search.structuredContent).toMatchObject({
        totalResults: 1,
        groups: [
          {
            selector: 'local-api@1',
            results: [expect.objectContaining({ title: 'Offline fixture' })],
          },
        ],
      });
    } finally {
      documentation.onModuleDestroy();
    }
    expect(fetchRequests).toEqual([]);
  });

  it('rejects a duplicate selector before building or changing the catalog', async () => {
    await installLocalSnapshot(
      docsDirectory,
      'local-api@1',
      installOptions(buildFixture),
    );
    const registryBefore = readFileSync(join(catalogRoot, 'catalog.json'));
    let buildCalls = 0;
    const buildAgain: LocalDocumentationSnapshotBuilder = () => {
      buildCalls += 1;
      return Promise.resolve(undefined);
    };

    await expect(
      installLocalSnapshot(
        docsDirectory,
        'local-api@1',
        installOptions(buildAgain),
      ),
    ).rejects.toThrow('Catalog already contains local-api@1');

    expect(buildCalls).toBe(0);
    expect(readFileSync(join(catalogRoot, 'catalog.json'))).toEqual(
      registryBefore,
    );
    expect(fetchRequests).toEqual([]);
  });

  it('cleans private staging output and leaves the catalog untouched after build failure', async () => {
    let stagingDirectory = '';
    const failingBuilder: LocalDocumentationSnapshotBuilder = (
      _input,
      _selector,
      output,
    ) => {
      stagingDirectory = output;
      writeFileSync(join(output, 'partial-output'), 'partial');
      return Promise.reject(new Error('synthetic build failure'));
    };

    await expect(
      installLocalSnapshot(
        docsDirectory,
        'local-api@1',
        installOptions(failingBuilder),
      ),
    ).rejects.toThrow('synthetic build failure');

    expect(stagingDirectory).not.toBe('');
    expect(existsSync(stagingDirectory)).toBe(false);
    expect(existsSync(catalogRoot)).toBe(false);
    expect(fetchRequests).toEqual([]);
  });

  it('cleans invalid built output and leaves the catalog untouched', async () => {
    let stagingDirectory = '';
    const invalidBuilder: LocalDocumentationSnapshotBuilder = (
      _input,
      _selector,
      output,
    ) => {
      stagingDirectory = output;
      writeFileSync(join(output, 'manifest.json'), '{invalid');
      return Promise.resolve(undefined);
    };

    await expect(
      installLocalSnapshot(
        docsDirectory,
        'local-api@1',
        installOptions(invalidBuilder),
      ),
    ).rejects.toThrow(/snapshot|manifest|directory/iu);

    expect(existsSync(stagingDirectory)).toBe(false);
    expect(existsSync(catalogRoot)).toBe(false);
    expect(fetchRequests).toEqual([]);
  });

  it('rejects a symlinked input root without creating staging or catalog files', async () => {
    const symlinkedDirectory = join(root, 'docs-link');
    symlinkSync(docsDirectory, symlinkedDirectory, 'dir');
    let buildCalled = false;
    const build: LocalDocumentationSnapshotBuilder = () => {
      buildCalled = true;
      return Promise.resolve(undefined);
    };

    await expect(
      installLocalSnapshot(
        symlinkedDirectory,
        'local-api@1',
        installOptions(build),
      ),
    ).rejects.toThrow(/real directory|symbolic link/u);

    expect(buildCalled).toBe(false);
    expect(existsSync(catalogRoot)).toBe(false);
    expect(fetchRequests).toEqual([]);
  });

  it('rejects an empty documentation directory after cleaning its staging output', async () => {
    const emptyDirectory = join(root, 'empty-docs');
    mkdirSync(emptyDirectory);
    let stagingDirectory = '';

    await expect(
      installLocalSnapshot(
        emptyDirectory,
        'empty-api@1',
        installOptions(async (input, selector, output) => {
          stagingDirectory = output;
          return buildFixture(input, selector, output);
        }),
      ),
    ).rejects.toThrow(/No Markdown or MDX files/u);

    expect(existsSync(stagingDirectory)).toBe(false);
    expect(existsSync(catalogRoot)).toBe(false);
    expect(fetchRequests).toEqual([]);
  });

  function installOptions(builder: LocalDocumentationSnapshotBuilder) {
    return {
      catalogRoot,
      packageDataDirectory,
      builder,
    };
  }
});

async function buildFixture(
  inputDirectory: string,
  selector: string,
  outputDirectory: string,
): Promise<unknown> {
  const separator = selector.lastIndexOf('@');
  return buildLocalDocumentation(
    {
      id: selector.slice(0, separator),
      version: selector.slice(separator + 1),
      inputDirectory,
      outputDirectory,
      maxChunkChars: 4000,
      routeMapping: {
        baseUrl: `https://docs.example.test/${selector.slice(0, separator)}`,
        pathPrefix: '',
        indexFileNames: ['index', 'readme'],
      },
    },
    { mode: 'clean' },
  );
}
