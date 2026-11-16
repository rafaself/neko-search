import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLocalDocumentation } from '../../../../apps/docs-indexer/src/services/build-local-documentation.js';
import {
  getCatalogIndex,
  listCatalogIndexes,
} from '../../../../src/apps/nekosearch/catalog.js';
import {
  installGitHubSnapshot,
  type GitHubSnapshotBuilder,
} from '../../../../src/apps/nekosearch/github-snapshots.js';
import {
  getSnapshotTrackingState,
  installRemoteSnapshot,
} from '../../../../src/apps/nekosearch/remote-snapshots.js';
import { TestDocumentationSearchService } from '../../../fixtures/test-documentation-search-service.js';

const packageDataDirectory = resolve(process.cwd(), 'data');
const repositoryUrl = 'https://github.com/acme/reference-docs';
const revision = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const firstDocument =
  '# Reference guide\n\nContainer bindings explain dependency injection setup.\n';
const secondDocument =
  '# Nested guide\n\nThis page contains offline adapter configuration.\n';

const validTree = [
  { path: 'docs', mode: '040000', type: 'tree' },
  {
    path: 'docs/index.md',
    mode: '100644',
    type: 'blob',
    size: Buffer.byteLength(firstDocument),
  },
  { path: 'docs/nested', mode: '040000', type: 'tree' },
  {
    path: 'docs/nested/guide.mdx',
    mode: '100644',
    type: 'blob',
    size: Buffer.byteLength(secondDocument),
  },
  {
    path: 'docs/ignored.txt',
    mode: '100644',
    type: 'blob',
    size: 10,
  },
  {
    path: 'docs/symlink.md',
    mode: '120000',
    type: 'blob',
    size: 12,
  },
  { path: 'docs/vendor', mode: '160000', type: 'commit' },
  {
    path: 'outside/ignored.md',
    mode: '100644',
    type: 'blob',
    size: 12,
  },
];

describe('NekoSearch public GitHub snapshots', () => {
  let root: string;
  let catalogRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-github-add-'));
    catalogRoot = join(root, 'catalog');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves and installs only Markdown and MDX files from the pinned directory', async () => {
    const upstream = mockGitHub({
      tree: validTree,
      rawFiles: {
        'docs/index.md': firstDocument,
        'docs/nested/guide.mdx': secondDocument,
      },
    });
    const installed = await installGitHubSnapshot(
      repositoryUrl,
      'feature/docs',
      'docs',
      'reference@1',
      githubOptions(catalogRoot, upstream.fetcher),
    );

    expect(installed).toMatchObject({
      source: 'reference',
      version: '1',
      revision,
      status: 'installed',
      manifest: {
        source: {
          kind: 'git',
          repository: repositoryUrl,
          ref: 'feature/docs',
          directory: 'docs',
          revision,
        },
      },
    });
    expect(installed.trackingRecipe).toBeUndefined();
    expect(getSnapshotTrackingState(installed)).toBe('untracked');
    expect(upstream.requestedUrls()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/commits/feature%2Fdocs'),
        expect.stringContaining(`/git/trees/${treeSha}?recursive=1`),
        `https://raw.githubusercontent.com/acme/reference-docs/${revision}/docs/index.md`,
        `https://raw.githubusercontent.com/acme/reference-docs/${revision}/docs/nested/guide.mdx`,
      ]),
    );
    expect(upstream.requestedUrls()).toHaveLength(4);
    expect(
      upstream.requests.every(({ init }) => init?.redirect === 'error'),
    ).toBe(true);
    expect(
      upstream.requests.every(
        ({ init }) => init?.signal instanceof AbortSignal,
      ),
    ).toBe(true);

    const entry = await getCatalogIndex('reference@1', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(entry).toBeDefined();
    const documentation = new TestDocumentationSearchService(
      entry!.databasePath,
      entry!.version,
    );
    try {
      const hit = documentation.search('container bindings')[0];
      expect(hit).toBeDefined();
      expect(hit?.sourceRevision).toBe(revision);
      const fetched = documentation.fetchDocument(hit!.documentId);
      if (!fetched)
        throw new Error('Installed GitHub document was not fetchable');
      expect(
        fetched.sections.map((section) => section.markdown).join('\n'),
      ).toContain('dependency injection setup');
      expect(
        upstream
          .requestedUrls()
          .filter((url) => url.includes('raw.githubusercontent.com')),
      ).toHaveLength(2);
    } finally {
      documentation.onModuleDestroy();
    }
  });

  it('rejects unsupported hosts and unsafe requested directories before networking', async () => {
    const upstream = mockGitHub({ tree: validTree });

    await expect(
      installGitHubSnapshot(
        'https://github.example/acme/docs',
        'main',
        'docs',
        'invalid-host@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/Only public https:\/\/github\.com/u);
    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        '../docs',
        'unsafe-dir@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/safe relative repository path|unsafe path component/u);

    expect(upstream.requests).toEqual([]);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects a missing ref without creating a catalog entry', async () => {
    const upstream = mockGitHub({ commitStatus: 404, tree: validTree });

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'missing/ref',
        'docs',
        'reference@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/HTTP 404.*commit ref/u);

    expect(upstream.requestedUrls()).toHaveLength(1);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects unsafe tree paths and never requests their contents', async () => {
    const upstream = mockGitHub({
      tree: [
        {
          path: 'docs/../outside.md',
          mode: '100644',
          type: 'blob',
          size: 10,
        },
      ],
      rawFiles: { 'docs/../outside.md': 'unsafe' },
    });

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'unsafe-tree@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/unsafe path component/u);

    expect(
      upstream
        .requestedUrls()
        .filter((url) => url.includes('raw.githubusercontent.com')),
    ).toEqual([]);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects oversized documents before downloading their content', async () => {
    const upstream = mockGitHub({
      tree: [
        {
          path: 'docs/large.md',
          mode: '100644',
          type: 'blob',
          size: 4 * 1024 * 1024 + 1,
        },
      ],
      rawFiles: { 'docs/large.md': 'not downloaded' },
    });

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'oversized@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/per-file limit/u);

    expect(
      upstream
        .requestedUrls()
        .filter((url) => url.includes('raw.githubusercontent.com')),
    ).toEqual([]);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('enforces file-count and combined-byte limits before downloading content', async () => {
    const tooManyFiles = mockGitHub({
      tree: Array.from({ length: 10_001 }, (_, index) => ({
        path: `docs/${String(index).padStart(5, '0')}.md`,
        mode: '100644',
        type: 'blob',
        size: 0,
      })),
    });
    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'too-many@1',
        githubOptions(catalogRoot, tooManyFiles.fetcher),
      ),
    ).rejects.toThrow(/10000-file limit/u);
    expect(
      tooManyFiles
        .requestedUrls()
        .filter((url) => url.includes('raw.githubusercontent.com')),
    ).toEqual([]);

    const tooManyBytes = mockGitHub({
      tree: Array.from({ length: 17 }, (_, index) => ({
        path: `docs/${String(index).padStart(2, '0')}.md`,
        mode: '100644',
        type: 'blob',
        size: 4 * 1024 * 1024,
      })),
    });
    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'too-large-total@1',
        githubOptions(catalogRoot, tooManyBytes.fetcher),
      ),
    ).rejects.toThrow(/67108864-byte total limit/u);
    expect(
      tooManyBytes
        .requestedUrls()
        .filter((url) => url.includes('raw.githubusercontent.com')),
    ).toEqual([]);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('enforces the byte limit even when the pinned tree understates a file size', async () => {
    const oversizedContent = 'x'.repeat(4 * 1024 * 1024 + 1);
    const upstream = mockGitHub({
      tree: [
        {
          path: 'docs/large.md',
          mode: '100644',
          type: 'blob',
          size: 4,
        },
      ],
      rawFiles: { 'docs/large.md': oversizedContent },
    });

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'oversized-response@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow(/exceeds the 4194304-byte limit/u);

    expect(existsSync(catalogRoot)).toBe(false);
  });

  it('rejects interrupted downloads and preserves the existing active snapshot', async () => {
    const validUpstream = mockGitHub({
      tree: validTree,
      rawFiles: {
        'docs/index.md': firstDocument,
        'docs/nested/guide.mdx': secondDocument,
      },
    });
    const active = await installGitHubSnapshot(
      repositoryUrl,
      'main',
      'docs',
      'reference@1',
      githubOptions(catalogRoot, validUpstream.fetcher),
    );
    const catalogBefore = JSON.stringify(
      await listCatalogIndexes({ catalogRoot, packageDataDirectory }),
      (_key, value: unknown) =>
        typeof value === 'string' && value.startsWith(catalogRoot)
          ? '<catalog-path>'
          : value,
    );
    const interrupted = mockGitHub({
      tree: [
        {
          path: 'docs/interrupted.md',
          mode: '100644',
          type: 'blob',
          size: 30,
        },
      ],
      interruptedPaths: new Set(['docs/interrupted.md']),
    });

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'main',
        'docs',
        'second-source@1',
        githubOptions(catalogRoot, interrupted.fetcher),
      ),
    ).rejects.toThrow(/interrupted|download|fetching documentation/u);

    const catalogAfter = JSON.stringify(
      await listCatalogIndexes({ catalogRoot, packageDataDirectory }),
      (_key, value: unknown) =>
        typeof value === 'string' && value.startsWith(catalogRoot)
          ? '<catalog-path>'
          : value,
    );
    expect(catalogAfter).toBe(catalogBefore);
    expect(
      await getCatalogIndex('reference@1', {
        catalogRoot,
        packageDataDirectory,
      }),
    ).toMatchObject({ revision: active.revision });
    expect(
      await getCatalogIndex('second-source@1', {
        catalogRoot,
        packageDataDirectory,
      }),
    ).toBeUndefined();
    expect(interrupted.requestedUrls()).toHaveLength(3);
  });

  it('does not overwrite an existing selector or make a network request for it', async () => {
    const upstream = mockGitHub({
      tree: validTree,
      rawFiles: {
        'docs/index.md': firstDocument,
        'docs/nested/guide.mdx': secondDocument,
      },
    });
    const installed = await installGitHubSnapshot(
      repositoryUrl,
      'main',
      'docs',
      'reference@1',
      githubOptions(catalogRoot, upstream.fetcher),
    );
    const requestCount = upstream.requests.length;

    await expect(
      installGitHubSnapshot(
        repositoryUrl,
        'different-ref',
        'docs',
        'reference@1',
        githubOptions(catalogRoot, upstream.fetcher),
      ),
    ).rejects.toThrow('Catalog already contains reference@1');

    expect(upstream.requests).toHaveLength(requestCount);
    expect(
      await getCatalogIndex('reference@1', {
        catalogRoot,
        packageDataDirectory,
      }),
    ).toMatchObject({ revision: installed.revision });
  });

  it('does not let GitHub provenance alone enable curated update behavior', async () => {
    const upstream = mockGitHub({
      tree: validTree,
      rawFiles: {
        'docs/index.md': firstDocument,
        'docs/nested/guide.mdx': secondDocument,
      },
    });
    await installGitHubSnapshot(
      repositoryUrl,
      'main',
      'docs',
      'nestjs@12',
      githubOptions(catalogRoot, upstream.fetcher),
    );
    const requestCount = upstream.requests.length;

    await expect(
      installRemoteSnapshot('nestjs', '12', 'update', {
        catalogRoot,
        packageDataDirectory,
        fetcher: upstream.fetcher,
      }),
    ).rejects.toThrow(/not linked to its matching curated recipe/u);

    expect(upstream.requests).toHaveLength(requestCount);
    const installed = await getCatalogIndex('nestjs@12', {
      catalogRoot,
      packageDataDirectory,
    });
    expect(installed).toMatchObject({
      manifest: {
        source: {
          kind: 'git',
          repository: repositoryUrl,
          ref: 'main',
          directory: 'docs',
          revision,
        },
      },
    });
    expect(installed?.trackingRecipe).toBeUndefined();
  });
});

function githubOptions(catalogRoot: string, fetcher: typeof fetch) {
  return {
    catalogRoot,
    packageDataDirectory,
    fetcher,
    snapshotBuilder: async (
      configuration: Parameters<GitHubSnapshotBuilder>[0],
      options: Parameters<GitHubSnapshotBuilder>[1],
    ) =>
      buildLocalDocumentation(
        { ...configuration, maxChunkChars: 4000 },
        options,
      ),
  };
}

function mockGitHub(options: {
  commitStatus?: number;
  tree: Array<Record<string, unknown>>;
  truncated?: boolean;
  rawFiles?: Record<string, string>;
  interruptedPaths?: Set<string>;
}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? input
          : new URL(input);
    requests.push({ url: url.href, init });
    if (url.hostname === 'api.github.com') {
      if (url.pathname.includes('/commits/')) {
        return Promise.resolve(
          options.commitStatus
            ? new Response('missing ref', { status: options.commitStatus })
            : new Response(
                JSON.stringify({
                  sha: revision,
                  commit: { tree: { sha: treeSha } },
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            truncated: options.truncated ?? false,
            tree: options.tree,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const rawPath = decodeURIComponent(url.pathname)
        .split('/')
        .slice(4)
        .join('/');
      if (options.interruptedPaths?.has(rawPath)) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial body'));
            controller.error(new Error('connection interrupted'));
          },
        });
        return Promise.resolve(
          new Response(stream, {
            headers: { 'content-length': '30' },
          }),
        );
      }
      const content = options.rawFiles?.[rawPath];
      return Promise.resolve(
        content === undefined
          ? new Response('missing file', { status: 404 })
          : new Response(content, {
              headers: {
                'content-length': String(Buffer.byteLength(content)),
              },
            }),
      );
    }
    return Promise.resolve(new Response('disallowed host', { status: 400 }));
  };
  return {
    fetcher,
    requests,
    requestedUrls: () => requests.map(({ url }) => url),
  };
}
