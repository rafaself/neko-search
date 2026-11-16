import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DocumentationCorpusSchema } from '@nestjs-docs/documentation-engine/domain/documentation.schemas.js';
import { DocumentationIndexWriter } from '@nestjs-docs/documentation-engine/infrastructure/sqlite/indexing/index-writer.js';
import {
  createMcpServerTestIndex,
  createTestIndexManifest,
} from '../../../fixtures/mcp-server-index.js';
import { listCatalogIndexes } from '../../../../src/apps/nekosearch/catalog.js';
import { installRemoteSnapshot } from '../../../../src/apps/nekosearch/remote-snapshots.js';

const officialRepository = 'rafaself/neko-search';
const officialSourceRepository = 'https://github.com/nestjs/docs.nestjs.com';
const apiBase = `https://api.github.com/repos/${officialRepository}`;
const dataDirectory = resolve(process.cwd(), 'data');

describe('NekoSearch official remote snapshots', () => {
  let root: string;
  let catalogRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-remote-'));
    catalogRoot = join(root, 'xdg', 'nekosearch');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs, updates only the requested major, no-ops when current, and serves the new revision', async () => {
    const firstRevision = 'a'.repeat(40);
    const secondRevision = 'b'.repeat(40);
    const firstArchive = createOfficialArchive({
      '11': 'c'.repeat(40),
      '12': firstRevision,
    });
    const first = await installRemoteSnapshot(
      'nestjs',
      '12',
      'add',
      remoteOptions(
        createReleaseFetcher(firstArchive, firstRevision).fetcher,
        catalogRoot,
      ),
    );
    expect(first).toMatchObject({
      changed: true,
      entry: {
        source: 'nestjs',
        version: '12',
        revision: firstRevision,
        status: 'installed',
      },
    });

    const secondArchive = createOfficialArchive({
      '11': 'd'.repeat(40),
      '12': secondRevision,
    });
    const update = await installRemoteSnapshot(
      'nestjs',
      '12',
      'update',
      remoteOptions(
        createReleaseFetcher(secondArchive, secondRevision).fetcher,
        catalogRoot,
      ),
    );
    expect(update).toMatchObject({
      changed: true,
      entry: {
        source: 'nestjs',
        version: '12',
        revision: secondRevision,
        status: 'installed',
      },
    });
    expect(await listCatalogIndexes({ catalogRoot })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'nestjs',
          version: '12',
          revision: secondRevision,
          status: 'installed',
        }),
      ]),
    );
    expect(
      (await listCatalogIndexes({ catalogRoot })).some(
        (entry) => entry.source === 'nestjs' && entry.version === '11',
      ),
    ).toBe(false);

    const noOpFetcher = createReleaseFetcher(secondArchive, secondRevision);
    const noOp = await installRemoteSnapshot(
      'nestjs',
      '12',
      'update',
      remoteOptions(noOpFetcher.fetcher, catalogRoot),
    );
    expect(noOp.changed).toBe(false);
    expect(noOpFetcher.downloads()).toBe(0);

    const freshCatalog = await listCatalogIndexes({ catalogRoot });
    expect(
      freshCatalog.find(
        (entry) => entry.source === 'nestjs' && entry.version === '12',
      ),
    ).toMatchObject({ revision: secondRevision, status: 'installed' });
  }, 20_000);

  it('leaves the active snapshot usable after an interrupted download', async () => {
    const activeRevision = 'e'.repeat(40);
    await installRevision(activeRevision);
    const brokenRevision = 'f'.repeat(40);
    const archive = createOfficialArchive({
      '11': '1'.repeat(40),
      '12': brokenRevision,
    });
    const fetcher = createReleaseFetcher(
      archive,
      brokenRevision,
      'interrupted',
    );

    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'update',
        remoteOptions(fetcher.fetcher, catalogRoot),
      ),
    ).rejects.toThrow(/interrupted|download/iu);
    await expectActiveRevision(activeRevision);
  });

  it('leaves the active snapshot usable after a tampered download', async () => {
    const activeRevision = '1'.repeat(40);
    await installRevision(activeRevision);
    const nextRevision = '2'.repeat(40);
    const authenticArchive = createOfficialArchive({
      '11': '3'.repeat(40),
      '12': nextRevision,
    });
    const fetcher = createReleaseFetcher(
      authenticArchive,
      nextRevision,
      'tampered',
    );

    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'update',
        remoteOptions(fetcher.fetcher, catalogRoot),
      ),
    ).rejects.toThrow(/SHA-256/iu);
    await expectActiveRevision(activeRevision);
  });

  it('rejects a release without a GitHub API digest before downloading its archive', async () => {
    const activeRevision = '3'.repeat(40);
    await installRevision(activeRevision);
    const nextRevision = '4'.repeat(40);
    const archive = createOfficialArchive({
      '11': '5'.repeat(40),
      '12': nextRevision,
    });
    const fetcher = createReleaseFetcher(archive, nextRevision, 'normal', true);

    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'update',
        remoteOptions(fetcher.fetcher, catalogRoot),
      ),
    ).rejects.toThrow(/metadata is invalid/iu);
    expect(fetcher.downloads()).toBe(0);
    await expectActiveRevision(activeRevision);
  });

  it('rejects unsupported majors and unsafe archive paths without creating a catalog', async () => {
    await expect(
      installRemoteSnapshot('nestjs', '13', 'add', {
        catalogRoot,
        packageDataDirectory: dataDirectory,
      }),
    ).rejects.toThrow(/support only/iu);
    expect(existsSync(catalogRoot)).toBe(false);

    const revision = '9'.repeat(40);
    const archive = createOfficialArchive(
      { '11': '8'.repeat(40), '12': revision },
      '../outside.txt',
    );
    await expect(
      installRemoteSnapshot(
        'nestjs',
        '12',
        'add',
        remoteOptions(
          createReleaseFetcher(archive, revision).fetcher,
          catalogRoot,
        ),
      ),
    ).rejects.toThrow(/unexpected|unsafe/iu);
    expect(existsSync(catalogRoot)).toBe(false);
  });

  async function installRevision(revision: string): Promise<void> {
    const archive = createOfficialArchive({
      '11': '7'.repeat(40),
      '12': revision,
    });
    await installRemoteSnapshot(
      'nestjs',
      '12',
      'add',
      remoteOptions(
        createReleaseFetcher(archive, revision).fetcher,
        catalogRoot,
      ),
    );
  }

  async function expectActiveRevision(revision: string): Promise<void> {
    const entries = await listCatalogIndexes({ catalogRoot });
    expect(
      entries.find(
        (entry) => entry.source === 'nestjs' && entry.version === '12',
      ),
    ).toMatchObject({ revision, status: 'installed' });
  }
});

function remoteOptions(
  fetcher: typeof fetch,
  catalogRoot: string,
): {
  fetcher: typeof fetch;
  catalogRoot: string;
  packageDataDirectory: string;
} {
  return { fetcher, catalogRoot, packageDataDirectory: dataDirectory };
}

function createReleaseFetcher(
  archive: Buffer,
  revision: string,
  downloadMode: 'normal' | 'tampered' | 'interrupted' = 'normal',
  omitApiDigest = false,
): { fetcher: typeof fetch; downloads: () => number } {
  const tag = `docs-index-${revision.slice(0, 12)}`;
  const assetUrl = `https://github.com/${officialRepository}/releases/download/${tag}/documentation-indexes.tar.gz`;
  const assetDigest = createHash('sha256').update(archive).digest('hex');
  const release = {
    id: 700,
    tag_name: tag,
    name: 'NestJS documentation indexes',
    body: [
      `- NestJS v11 source revision: [\`${'4'.repeat(40)}\`](https://github.com/nestjs/docs.nestjs.com/commit/${'4'.repeat(40)})`,
      `- NestJS v12 source revision: [\`${revision}\`](https://github.com/nestjs/docs.nestjs.com/commit/${revision})`,
    ].join('\n'),
    draft: false,
    prerelease: true,
    published_at: '2026-11-15T00:00:00Z',
    created_at: '2026-11-15T00:00:00Z',
    assets_url: `${apiBase}/releases/700/assets`,
    assets: [
      {
        name: 'documentation-indexes.tar.gz',
        size: archive.byteLength,
        digest: omitApiDigest ? null : `sha256:${assetDigest}`,
        state: 'uploaded',
        browser_download_url: assetUrl,
      },
    ],
  };
  let downloadCount = 0;
  const fetcher: typeof fetch = (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let response: Response;
    if (url === `${apiBase}`) {
      response = new Response(
        JSON.stringify({ id: 1455942811, full_name: officialRepository }),
        { status: 200 },
      );
    } else if (url === `${apiBase}/releases?per_page=100`) {
      response = new Response(JSON.stringify([release]), { status: 200 });
    } else if (url === assetUrl) {
      downloadCount += 1;
      if (downloadMode === 'interrupted') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(archive.subarray(0, 16));
            controller.error(new Error('connection interrupted'));
          },
        });
        response = new Response(stream, { status: 200 });
      } else if (downloadMode === 'tampered') {
        const tampered = Buffer.from(archive);
        tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
        response = new Response(tampered, { status: 200 });
      } else {
        response = new Response(archive, { status: 200 });
      }
    } else {
      return Promise.reject(new Error(`Unexpected test fetch: ${url}`));
    }
    return Promise.resolve(response);
  };
  return { fetcher, downloads: () => downloadCount };
}

function createOfficialArchive(
  revisions: Record<'11' | '12', string>,
  extraPath?: string,
): Buffer {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'nekosearch-release-fixture-'),
  );
  try {
    const files = new Map<string, Buffer>();
    const versionEntries: Record<string, Record<string, unknown>> = {};
    for (const version of ['11', '12'] as const) {
      const corpusPath = join(
        temporaryDirectory,
        `documentation-v${version}.json`,
      );
      const databasePath = join(
        temporaryDirectory,
        `documentation-v${version}.sqlite`,
      );
      const runtimeManifestPath = join(
        temporaryDirectory,
        `documentation-v${version}.manifest.json`,
      );
      const source = {
        kind: 'git' as const,
        repository: officialSourceRepository,
        ref: version === '11' ? '11.0.0' : 'master',
        revision: revisions[version],
      };
      const localCorpusPath = join(
        temporaryDirectory,
        `fixture-v${version}.sqlite`,
      );
      const initialCorpus = createMcpServerTestIndex(localCorpusPath, version);
      const corpus = DocumentationCorpusSchema.parse({
        ...initialCorpus,
        source,
        documents: initialCorpus.documents.map((document) => ({
          ...document,
          source: {
            ...document.source,
            provenance: source,
            location: `https://raw.githubusercontent.com/nestjs/docs.nestjs.com/${source.revision}/${document.source.path}`,
          },
          chunks: document.chunks.map((chunk) => ({
            ...chunk,
            sourceRevision: source.revision,
          })),
        })),
      });
      const writer = new DocumentationIndexWriter(localCorpusPath, version);
      try {
        writer.indexCorpus(corpus);
      } finally {
        writer.close();
      }
      const corpusBytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`);
      const indexBytes = readFileSync(localCorpusPath);
      writeFileSync(corpusPath, corpusBytes);
      writeFileSync(databasePath, indexBytes);
      const runtimeManifest = createTestIndexManifest(
        databasePath,
        corpus,
        officialSourceRepository,
      );
      runtimeManifest.index.file = `documentation-v${version}.sqlite`;
      const runtimeManifestBytes = Buffer.from(
        `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      );
      writeFileSync(runtimeManifestPath, runtimeManifestBytes);
      files.set(`documentation-v${version}.json`, corpusBytes);
      files.set(`documentation-v${version}.sqlite`, indexBytes);
      files.set(
        `documentation-v${version}.manifest.json`,
        runtimeManifestBytes,
      );
      const chunkCount = corpus.documents.reduce(
        (total, document) => total + document.chunks.length,
        0,
      );
      versionEntries[version] = {
        version: Number(version),
        ref: source.ref,
        revision: source.revision,
        documentCount: corpus.documents.length,
        chunkCount,
        sourceContentHashes: Object.fromEntries(
          corpus.documents.map((document) => [
            document.id,
            document.source.contentHash,
          ]),
        ),
        normalizedContentHashes: Object.fromEntries(
          corpus.documents.map((document) => [
            document.id,
            document.contentHash,
          ]),
        ),
        corpusSha256: sha256(corpusBytes),
        indexSha256: sha256(indexBytes),
      };
      rmSync(localCorpusPath, { force: true });
    }
    const globalManifest = {
      formatVersion: 1,
      indexPipelineVersion: 2,
      repository: officialSourceRepository,
      versions: versionEntries,
    };
    files.set(
      'manifest.json',
      Buffer.from(`${JSON.stringify(globalManifest, null, 2)}\n`),
    );
    if (extraPath) files.set(extraPath, Buffer.from('unsafe'));
    return gzipSync(createUstarArchive(files));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function createUstarArchive(files: Map<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, contents] of files) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, contents.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarString(header, 257, 6, 'ustar\0');
    writeTarString(header, 263, 2, '00');
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 32;
    blocks.push(header, contents);
    const padding = (512 - (contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeTarString(
  header: Buffer,
  start: number,
  length: number,
  value: string,
): void {
  header.write(value, start, length, 'ascii');
}

function writeTarOctal(
  header: Buffer,
  start: number,
  length: number,
  value: number,
): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  header.write(`${digits}\0`, start, length, 'ascii');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
