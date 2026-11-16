import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';
import { loadIngestionFixtures } from '../../../fixtures/ingestion.fixtures.js';
import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  buildNestJsDocumentationSnapshot,
  resolveDocumentationSource,
} from '../../../../apps/docs-indexer/src/integrations/nestjs/documentation.integration.js';
import { sourceUrl } from '../../../../apps/docs-indexer/src/integrations/nestjs/github/documentation-source.js';
import {
  addSnapshot,
  getCatalogIndex,
  listCatalogIndexes,
  updateSnapshot,
} from '../../../../src/apps/nekosearch/catalog.js';
import {
  checkUpstreamRevisions,
  installRemoteSnapshot,
  type NestJsSnapshotBuilder,
  type RemoteSnapshotOptions,
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
    const generatedCorpus = JSON.parse(
      await readFile(join(installedSnapshotDirectory, 'corpus.json'), 'utf8'),
    ) as DocumentationCorpus;
    const introduction = generatedCorpus.documents.find(
      (document) => document.source.path === 'content/introduction.md',
    )!;
    const providers = generatedCorpus.documents.find(
      (document) => document.source.path === 'content/components.md',
    )!;
    expect(
      introduction.chunks.flatMap((chunk) => chunk.references ?? []),
    ).toContainEqual(
      expect.objectContaining({
        href: '/providers',
        documentId: providers.id,
      }),
    );
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

  it('reports current and changed tracked refs without downloading documentation files', async () => {
    const installedRevision = '2'.repeat(40);
    await installRevision(installedRevision);

    const currentUpstream = createV12Upstream(installedRevision);
    await expect(
      checkInstalledUpstream(
        remoteOptions(currentUpstream.fetcher),
        'nestjs@12',
      ),
    ).resolves.toMatchObject([
      {
        selector: 'nestjs@12',
        status: 'current',
        installedRevision,
        upstreamRevision: installedRevision,
      },
    ]);
    expect(currentUpstream.requestedRefNames()).toEqual(['master']);
    expect(currentUpstream.requestedRawPaths()).toEqual([]);

    const changedUpstream = createV12Upstream('3'.repeat(40));
    await expect(
      checkInstalledUpstream(remoteOptions(changedUpstream.fetcher)),
    ).resolves.toMatchObject([
      {
        selector: 'nestjs@12',
        status: 'changed',
        installedRevision,
        upstreamRevision: '3'.repeat(40),
      },
    ]);
    expect(changedUpstream.requestedRefNames()).toEqual(['master']);
    expect(changedUpstream.requestedRawPaths()).toEqual([]);
  }, 20_000);

  it('reports a moved ref without claiming v12 compatibility and rejects an incompatible update', async () => {
    const activeRevision = '7'.repeat(40);
    const movedRevision = '8'.repeat(40);
    await installRevision(activeRevision);

    const incompatibleUpstream = createV12Upstream(movedRevision, {
      migrationGuide:
        'This article walks you through migrating from NestJS version 10 to version 11.',
    });
    await expect(
      checkInstalledUpstream(
        remoteOptions(incompatibleUpstream.fetcher),
        'nestjs@12',
      ),
    ).resolves.toMatchObject([
      {
        selector: 'nestjs@12',
        status: 'changed',
        installedRevision: activeRevision,
        upstreamRevision: movedRevision,
      },
    ]);
    expect(incompatibleUpstream.requestedRefNames()).toEqual(['master']);
    expect(incompatibleUpstream.requestedRawPaths()).toEqual([]);

    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'update',
        remoteOptions(incompatibleUpstream.fetcher),
      ),
    ).rejects.toThrow(/no longer identifies a v12 migration guide/iu);
    expect(incompatibleUpstream.requestedRefNames()).toEqual([
      'master',
      'master',
    ]);
    expect(incompatibleUpstream.requestedRawPaths()).toContain(
      'content/migration.md',
    );
    await expectActiveRevision(activeRevision);
  }, 20_000);

  it('reports upstream failures as check failed and leaves add-from Git provenance untracked', async () => {
    const installedRevision = '4'.repeat(40);
    await installRevision(installedRevision);
    const failedCheck = await checkInstalledUpstream(
      {
        ...remoteOptions(() =>
          Promise.resolve(new Response('unavailable', { status: 503 })),
        ),
      },
      'nestjs@12',
    );
    expect(failedCheck).toMatchObject([
      { selector: 'nestjs@12', status: 'check failed', installedRevision },
    ]);
    expect(failedCheck[0]?.error).toMatch(/503|resolve|upstream/iu);

    const fromRevision = '5'.repeat(40);
    const fromUpstream = createV12Upstream(fromRevision);
    const importedDirectory = mkdtempSync(
      join(tmpdir(), 'nekosearch-from-git-snapshot-'),
    );
    try {
      await sourceBuilder.buildNestJsDocumentationSnapshot(
        '12',
        importedDirectory,
        fromUpstream.fetcher,
        {
          kind: 'git',
          repository: officialRepository,
          ref: 'master',
          revision: fromRevision,
        },
      );
      const importedCatalogRoot = join(root, 'xdg', 'imported-catalog');
      const importedOptions = {
        catalogRoot: importedCatalogRoot,
        packageDataDirectory: dataDirectory,
      };
      const imported = await addSnapshot(importedDirectory, importedOptions);
      expect(imported.trackingRecipe).toBeUndefined();
      expect(
        await checkInstalledUpstream({
          ...importedOptions,
          fetcher: fromUpstream.fetcher,
          sourceBuilder,
        }),
      ).toMatchObject([{ selector: 'nestjs@12', status: 'untracked' }]);
      expect(
        await checkInstalledUpstream(
          {
            ...importedOptions,
            fetcher: fromUpstream.fetcher,
            sourceBuilder,
          },
          'nestjs@12',
        ),
      ).toMatchObject([{ selector: 'nestjs@12', status: 'untracked' }]);
      expect(fromUpstream.requestedRefNames()).toEqual([]);

      await expect(getCatalogIndex('nestjs@11', importedOptions)).resolves.toBe(
        undefined,
      );

      const pinnedRevision = '6'.repeat(40);
      const pinnedUpstream = createV12Upstream(pinnedRevision);
      const pinnedBuilder: NestJsSnapshotBuilder = {
        resolveDocumentationSource: () =>
          Promise.resolve({
            kind: 'git',
            repository: officialRepository,
            ref: pinnedRevision,
            revision: pinnedRevision,
          }),
        buildNestJsDocumentationSnapshot: async (
          version,
          outputDirectory,
          fetcher,
          resolvedSource,
        ) => {
          await sourceBuilder.buildNestJsDocumentationSnapshot(
            version,
            outputDirectory,
            fetcher,
            { ...resolvedSource, ref: 'master' },
          );
          const manifestPath = join(outputDirectory, 'manifest.json');
          const corpusPath = join(outputDirectory, 'corpus.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            source: { ref: string };
            corpus: { sha256: string };
          };
          const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as {
            source: { ref: string };
            documents: { source: { provenance: { ref: string } } }[];
          };
          manifest.source.ref = resolvedSource.ref;
          corpus.source.ref = resolvedSource.ref;
          for (const document of corpus.documents) {
            document.source.provenance.ref = resolvedSource.ref;
          }
          const corpusBytes = Buffer.from(
            `${JSON.stringify(corpus, null, 2)}\n`,
            'utf8',
          );
          manifest.corpus.sha256 = createHash('sha256')
            .update(corpusBytes)
            .digest('hex');
          await writeFile(corpusPath, corpusBytes);
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
        },
      };
      const pinnedCatalogRoot = join(root, 'xdg', 'pinned-catalog');
      const pinnedOptions = {
        ...remoteOptions(pinnedUpstream.fetcher),
        catalogRoot: pinnedCatalogRoot,
        sourceBuilder: pinnedBuilder,
      };
      const pinned = await installRemoteSnapshot(
        'nestjs',
        '12',
        'add',
        pinnedOptions,
      );
      expect(pinned.entry.trackingRecipe).toBeUndefined();
      expect(await checkInstalledUpstream(pinnedOptions)).toMatchObject([
        { selector: 'nestjs@12', status: 'untracked' },
      ]);
      expect(
        await checkInstalledUpstream(pinnedOptions, 'nestjs@12'),
      ).toMatchObject([{ selector: 'nestjs@12', status: 'untracked' }]);
      expect(pinnedUpstream.requestedRefNames()).toEqual([]);
    } finally {
      rmSync(importedDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    ['matching upstream revision', '5'.repeat(40)],
    ['different upstream revision', '6'.repeat(40)],
  ])(
    'rejects an imported official Git snapshot before network access when %s',
    async (_case, upstreamRevision) => {
      const importedRevision = '5'.repeat(40);
      const importedDirectory = mkdtempSync(
        join(tmpdir(), 'nekosearch-untracked-update-'),
      );
      try {
        await sourceBuilder.buildNestJsDocumentationSnapshot(
          '12',
          importedDirectory,
          createV12Upstream(importedRevision).fetcher,
          {
            kind: 'git',
            repository: officialRepository,
            ref: 'master',
            revision: importedRevision,
          },
        );
        const catalogOptions = {
          catalogRoot,
          packageDataDirectory: dataDirectory,
        };
        const imported = await addSnapshot(importedDirectory, catalogOptions);
        expect(imported).toMatchObject({
          source: 'nestjs',
          version: '12',
          revision: importedRevision,
          manifest: {
            source: {
              kind: 'git',
              repository: officialRepository,
              ref: 'master',
              revision: importedRevision,
            },
          },
        });
        expect(imported.trackingRecipe).toBeUndefined();
        const registryPath = join(catalogRoot, 'catalog.json');
        const registryBefore = await readFile(registryPath, 'utf8');
        let resolveCalls = 0;
        let fetchCalls = 0;
        const uncalledFetcher: typeof fetch = () => {
          fetchCalls += 1;
          return Promise.reject(new Error('network access was not expected'));
        };
        const upstreamBuilder: NestJsSnapshotBuilder = {
          resolveDocumentationSource: () => {
            resolveCalls += 1;
            return Promise.resolve({
              kind: 'git',
              repository: officialRepository,
              ref: 'master',
              revision: upstreamRevision,
            });
          },
          buildNestJsDocumentationSnapshot: () => {
            throw new Error('snapshot build was not expected');
          },
        };

        await expect(
          installRemoteSnapshot('nestjs', '12', 'update', {
            ...catalogOptions,
            fetcher: uncalledFetcher,
            sourceBuilder: upstreamBuilder,
          }),
        ).rejects.toThrow(/not linked to its matching curated recipe/u);
        expect(resolveCalls).toBe(0);
        expect(fetchCalls).toBe(0);
        expect(await readFile(registryPath, 'utf8')).toBe(registryBefore);
        await expectActiveRevision(importedRevision);
      } finally {
        rmSync(importedDirectory, { recursive: true, force: true });
      }
    },
  );

  it('rechecks the curated recipe link under the catalog lock before activation', async () => {
    const activeRevision = '7'.repeat(40);
    const nextRevision = '8'.repeat(40);
    await installRevision(activeRevision);
    const active = (
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      })
    ).find(
      (entry) =>
        entry.status === 'installed' &&
        entry.source === 'nestjs' &&
        entry.version === '12',
    );
    if (!active) throw new Error('Tracked snapshot was not installed');

    let signalBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolvePromise) => {
      signalBuildStarted = resolvePromise;
    });
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((resolvePromise) => {
      releaseBuild = resolvePromise;
    });
    const upstream = createV12Upstream(nextRevision);
    const gatedBuilder: NestJsSnapshotBuilder = {
      resolveDocumentationSource,
      buildNestJsDocumentationSnapshot: async (
        version,
        outputDirectory,
        fetcher,
        resolvedSource,
      ) => {
        signalBuildStarted();
        await buildGate;
        await buildNestJsDocumentationSnapshot(
          version,
          outputDirectory,
          fetcher,
          resolvedSource,
        );
      },
    };
    const update = installRemoteSnapshot('nestjs', '12', 'update', {
      ...remoteOptions(upstream.fetcher),
      sourceBuilder: gatedBuilder,
    });
    await buildStarted;

    await updateSnapshot(
      dirname(active.databasePath),
      {
        catalogRoot,
        packageDataDirectory: dataDirectory,
      },
      { trackingRecipe: null },
    );
    releaseBuild();
    await expect(update).rejects.toThrow(
      /no longer linked to curated recipe nestjs@12/u,
    );
    await expectActiveRevision(activeRevision);
    const after = (
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      })
    ).find(
      (entry) =>
        entry.status === 'installed' &&
        entry.source === 'nestjs' &&
        entry.version === '12',
    );
    expect(after?.trackingRecipe).toBeUndefined();
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

  async function checkInstalledUpstream(
    options: RemoteSnapshotOptions,
    selector?: string,
  ) {
    const entries = (await listCatalogIndexes(options)).filter(
      (entry) =>
        entry.status === 'installed' &&
        (selector === undefined ||
          `${entry.source}@${entry.version}` === selector),
    );
    return checkUpstreamRevisions(entries, options);
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
    options: { missingPath?: string; migrationGuide?: string } = {},
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
          options.migrationGuide ??
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
