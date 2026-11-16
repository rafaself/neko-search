import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';
import { loadIngestionFixtures } from '../../../fixtures/ingestion.fixtures.js';
import {
  buildNestJsDocumentationSnapshot,
  resolveDocumentationSource,
} from '../../../../apps/docs-indexer/src/integrations/nestjs/documentation.integration.js';
import { sourceUrl } from '../../../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import { listCatalogIndexes } from '../../../../src/apps/nekosearch/catalog.js';
import {
  installRemoteSnapshot,
  type NestJsSnapshotBuilder,
} from '../../../../src/apps/nekosearch/remote-snapshots.js';

const officialRepository = 'https://github.com/nestjs/docs.nestjs.com';
const apiBase = 'https://api.github.com/repos/nestjs/docs.nestjs.com';
const dataDirectory = resolve(process.cwd(), 'data');
const sourceBuilder: NestJsSnapshotBuilder = {
  resolveDocumentationSource,
  buildNestJsDocumentationSnapshot,
};

describe('NekoSearch curated source installs', () => {
  let root: string;
  let catalogRoot: string;
  let fixtureData: Awaited<ReturnType<typeof loadIngestionFixtures>>;

  beforeAll(async () => {
    fixtureData = await loadIngestionFixtures();
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-curated-source-'));
    catalogRoot = join(root, 'xdg', 'nekosearch');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('starts without NestJS, installs one commit-pinned major, then searches and fetches it locally', async () => {
    expect(
      (
        await listCatalogIndexes({
          catalogRoot,
          packageDataDirectory: dataDirectory,
        })
      ).filter((entry) => entry.source === 'nestjs'),
    ).toEqual([]);

    const revision = 'a'.repeat(40);
    const upstream = createV12Upstream(revision);
    const installed = await installRemoteSnapshot(
      'nestjs',
      '12',
      'add',
      remoteOptions(upstream.fetcher),
    );

    expect(installed).toMatchObject({
      changed: true,
      entry: {
        source: 'nestjs',
        version: '12',
        revision,
        status: 'installed',
        manifest: {
          source: {
            kind: 'git',
            repository: officialRepository,
            ref: 'master',
            revision,
          },
        },
      },
    });
    expect(upstream.requestedRefNames()).toEqual(['master']);
    expect(upstream.requestedDocumentPaths()).toEqual(
      expect.arrayContaining([
        'content/introduction.md',
        'content/components.md',
        'content/mcp/overview.md',
      ]),
    );
    expect(
      upstream
        .requestedDocumentPaths()
        .every((path) => path.startsWith('content/')),
    ).toBe(true);

    const installedSnapshotDirectory = dirname(installed.entry.databasePath);
    const buildManifest = JSON.parse(
      await readFile(join(installedSnapshotDirectory, 'manifest.json'), 'utf8'),
    ) as { source: { ref: string; revision: string } };
    expect(buildManifest.source).toEqual({
      kind: 'git',
      repository: officialRepository,
      ref: 'master',
      revision,
    });
    expect(
      (
        await listCatalogIndexes({
          catalogRoot,
          packageDataDirectory: dataDirectory,
        })
      )
        .filter((entry) => entry.source === 'nestjs')
        .map((entry) => `${entry.source}@${entry.version}`),
    ).toEqual(['nestjs@12']);

    const documentation = new TestDocumentationSearchService(
      installed.entry.databasePath,
      '12',
    );
    try {
      const hit = documentation.search('provider link')[0];
      expect(hit).toBeDefined();
      expect(hit?.sourceRevision).toBe(revision);
      const fetched = documentation.fetchDocument(hit!.documentId);
      if (!fetched) throw new Error('Installed document was not fetchable');
      expect(
        fetched.sections.map((section) => section.markdown).join('\n'),
      ).toContain('An introductory paragraph');
    } finally {
      documentation.onModuleDestroy();
    }
  }, 20_000);

  it('updates only the requested major, leaves other catalog entries alone, and skips an already-current ref', async () => {
    const firstRevision = 'b'.repeat(40);
    await installRevision(firstRevision);

    const secondRevision = 'c'.repeat(40);
    const updateFetcher = createV12Upstream(secondRevision);
    const updated = await installRemoteSnapshot(
      'nestjs',
      '12',
      'update',
      remoteOptions(updateFetcher.fetcher),
    );
    expect(updated).toMatchObject({
      changed: true,
      entry: { version: '12', revision: secondRevision },
    });
    expect(updateFetcher.requestedRefNames()).toEqual(['master']);
    const afterUpdate = await listCatalogIndexes({
      catalogRoot,
      packageDataDirectory: dataDirectory,
    });
    expect(
      afterUpdate.filter((entry) => entry.source === 'nestjs'),
    ).toHaveLength(1);
    expect(
      afterUpdate.some(
        (entry) => entry.source === 'nestjs' && entry.version === '11',
      ),
    ).toBe(false);

    const currentFetcher = createV12Upstream(secondRevision);
    const current = await installRemoteSnapshot(
      'nestjs',
      '12',
      'update',
      remoteOptions(currentFetcher.fetcher),
    );
    expect(current.changed).toBe(false);
    expect(currentFetcher.requestedRefNames()).toEqual(['master']);
    expect(currentFetcher.requestedRawPaths()).toEqual([]);
    expect(current.entry.revision).toBe(secondRevision);
  }, 20_000);

  it('fails explicitly on a missing curated ref and does not try a fallback', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = urlString(input);
      requests.push(url);
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    };

    await expect(
      installRemoteSnapshot('nestjs', '12', 'add', remoteOptions(fetcher)),
    ).rejects.toThrow(
      /NestJS v12 branch ref "master".*no default-branch fallback/iu,
    );
    expect(requests).toEqual([`${apiBase}/commits/master`]);
    expect(
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      }),
    ).toHaveLength(1);
  });

  it('preserves the active snapshot when an update cannot fetch a source file', async () => {
    const activeRevision = 'd'.repeat(40);
    await installRevision(activeRevision);

    const failedUpdate = createV12Upstream('e'.repeat(40), {
      missingPath: 'content/components.md',
    });
    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'update',
        remoteOptions(failedUpdate.fetcher),
      ),
    ).rejects.toThrow(/Download failed \(404\)/u);
    await expectActiveRevision(activeRevision);
  }, 20_000);

  it('preserves the active snapshot when local building or snapshot validation fails', async () => {
    const activeRevision = 'f'.repeat(40);
    await installRevision(activeRevision);
    const failedRevision = '1'.repeat(40);
    const resolved = {
      kind: 'git' as const,
      repository: officialRepository,
      ref: 'master',
      revision: failedRevision,
    };
    const failBuild: NestJsSnapshotBuilder = {
      resolveDocumentationSource: () => Promise.resolve(resolved),
      buildNestJsDocumentationSnapshot: () =>
        Promise.reject(new Error('mocked build failure')),
    };
    await expect(
      installRemoteSnapshot('nestjs', '12', 'update', {
        ...remoteOptions(() => Promise.resolve(new Response('unused'))),
        sourceBuilder: failBuild,
      }),
    ).rejects.toThrow('mocked build failure');
    await expectActiveRevision(activeRevision);

    const invalidSnapshot: NestJsSnapshotBuilder = {
      resolveDocumentationSource: () => Promise.resolve(resolved),
      buildNestJsDocumentationSnapshot: async (_version, outputDirectory) => {
        await writeFile(join(outputDirectory, 'unexpected.txt'), 'invalid');
      },
    };
    await expect(
      installRemoteSnapshot('nestjs', '12', 'update', {
        ...remoteOptions(() => Promise.resolve(new Response('unused'))),
        sourceBuilder: invalidSnapshot,
      }),
    ).rejects.toThrow(/must contain exactly/u);
    await expectActiveRevision(activeRevision);
  });

  async function installRevision(revision: string): Promise<void> {
    await installRemoteSnapshot(
      'nestjs',
      '12',
      'add',
      remoteOptions(createV12Upstream(revision).fetcher),
    );
  }

  async function expectActiveRevision(revision: string): Promise<void> {
    const entries = await listCatalogIndexes({
      catalogRoot,
      packageDataDirectory: dataDirectory,
    });
    expect(
      entries.find(
        (entry) => entry.source === 'nestjs' && entry.version === '12',
      ),
    ).toMatchObject({ revision, status: 'installed' });
  }

  function remoteOptions(fetcher: typeof fetch) {
    return {
      fetcher,
      sourceBuilder,
      catalogRoot,
      packageDataDirectory: dataDirectory,
    };
  }

  function createV12Upstream(
    revision: string,
    options: { missingPath?: string } = {},
  ) {
    const fixtureDocuments = new Map(
      fixtureData.snapshot.documents.map((document) => [
        document.path,
        document.markdown,
      ]),
    );
    const rawPaths: string[] = [];
    const refs: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = urlString(input);
      if (url.startsWith(`${apiBase}/commits/`)) {
        const ref = url.slice(`${apiBase}/commits/`.length);
        refs.push(ref);
        return Promise.resolve(Response.json({ sha: revision }));
      }
      const rawPrefix = sourceUrl(revision, '');
      if (!url.startsWith(rawPrefix)) {
        return Promise.reject(new Error(`Unexpected upstream request: ${url}`));
      }
      const path = url.slice(rawPrefix.length);
      rawPaths.push(path);
      if (options.missingPath === path) {
        return Promise.resolve(
          new Response('Missing fixture', { status: 404 }),
        );
      }
      const sourceFiles = new Map([
        ['src/app/shared/nav/nav-items.ts', fixtureData.index],
        ['tools/generate-llms-txt.ts', fixtureData.aliases],
        [
          'content/migration.md',
          'This article walks you through migrating from NestJS version 11 to version 12.',
        ],
        ...fixtureDocuments,
      ]);
      const body = sourceFiles.get(path);
      return Promise.resolve(
        new Response(body ?? 'Missing fixture', {
          status: body ? 200 : 404,
        }),
      );
    };
    return {
      fetcher,
      requestedRefNames: () => [...refs],
      requestedRawPaths: () => [...rawPaths],
      requestedDocumentPaths: () =>
        rawPaths.filter((path) => path.startsWith('content/')),
    };
  }
});

function urlString(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
