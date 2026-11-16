import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DocumentationCorpus } from '@nestjs-docs/documentation-engine/domain/documentation.types.js';
import {
  buildNestJsDocumentationSnapshot,
  resolveDocumentationSource,
} from '../../../../apps/docs-indexer/src/integrations/nestjs/documentation.integration.js';
import { addSnapshot } from '../../../../src/apps/nekosearch/catalog.js';
import {
  parseStatusArguments,
  renderStatus,
} from '../../../../src/apps/nekosearch/status.js';
import type { NestJsSnapshotBuilder } from '../../../../src/apps/nekosearch/remote-snapshots.js';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';

const dataDirectory = resolve(process.cwd(), 'data');
const officialRepository = 'https://github.com/nestjs/docs.nestjs.com';
const apiPrefix =
  'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/';
const sourceBuilder: NestJsSnapshotBuilder = {
  resolveDocumentationSource,
  buildNestJsDocumentationSnapshot,
};

describe('nekosearch status', () => {
  let root: string;
  let catalogRoot: string;
  let fetchRequests: string[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-status-'));
    catalogRoot = join(root, 'catalog');
    fetchRequests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input) => {
      const url = fetchUrl(input);
      fetchRequests.push(url);
      return Promise.reject(new Error(`Unexpected network request: ${url}`));
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('shows the offline overview, including bundled, curated, and imported snapshots', async () => {
    await createSnapshot('nestjs', '11', 'a'.repeat(40), {
      ref: '11.0.0',
      tracked: true,
    });
    await createSnapshot('nestjs', '12', 'b'.repeat(40), {
      ref: 'master',
      tracked: true,
    });
    await createSnapshot('imported-git', '1', 'c'.repeat(40), {
      ref: 'master',
    });
    await createSnapshot('imported-local', '2', 'local-r1');

    const result = await runStatus();

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('NekoSearch version:');
    expect(result.text).toContain('Catalog: readable');
    expect(result.text).toContain('mcp@2025-11-25');
    expect(result.text).toContain('nestjs@11');
    expect(result.text).toContain('nestjs@12');
    expect(result.text).toContain('imported-git@1');
    expect(result.text).toContain('imported-local@2');
    expect(result.text).toContain('curated\ttracked\tnot checked');
    expect(result.text).toContain('imported Git\tuntracked\tnot checked');
    expect(fetchRequests).toEqual([]);
  });

  it('shows one selected snapshot and does not open unrelated snapshot files', async () => {
    const unrelated = await createSnapshot('nestjs', '11', 'a'.repeat(40), {
      ref: '11.0.0',
      tracked: true,
    });
    await createSnapshot('nestjs', '12', 'b'.repeat(40), {
      ref: 'master',
      tracked: true,
    });
    writeFileSync(join(unrelated, 'manifest.json'), '{corrupt');

    const result = await runStatus('nestjs@12');

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('Snapshot: readable (nestjs@12)');
    expect(result.text).toContain('nestjs@12');
    expect(result.text).not.toContain('nestjs@11');
    expect(fetchRequests).toEqual([]);
  });

  it('reports unknown selectors clearly', async () => {
    const result = await runStatus('missing@1');

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('NekoSearch version:');
    expect(result.text).toContain('No snapshot exists for missing@1');
    expect(result.text).toContain('nekosearch list');
    expect(fetchRequests).toEqual([]);
  });

  it('reports a corrupt catalog as unreadable while preserving bundled inventory', async () => {
    mkdirSync(catalogRoot, { recursive: true });
    writeFileSync(join(catalogRoot, 'catalog.json'), '{corrupt');

    const result = await runStatus();

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain('NekoSearch version:');
    expect(result.text).toContain('Catalog: unreadable');
    expect(result.text).toContain('Catalog registry is not valid JSON');
    expect(result.text).toContain('mcp@2025-11-25');
    expect(fetchRequests).toEqual([]);
  });

  it('checks only the selected tracked ref and reports upstream failures separately', async () => {
    await createSnapshot('nestjs', '11', 'a'.repeat(40), {
      ref: '11.0.0',
      tracked: true,
    });
    await createSnapshot('nestjs', '12', 'b'.repeat(40), {
      ref: 'master',
      tracked: true,
    });
    await createSnapshot('imported-git', '1', 'c'.repeat(40), {
      ref: 'master',
    });
    const registryBefore = readFileSync(
      join(catalogRoot, 'catalog.json'),
      'utf8',
    );

    mockUpstream({ master: 'b'.repeat(40) });
    const current = await runStatus('nestjs@12', '--check-upstream');
    expect(current.exitCode).toBe(0);
    expect(current.text).toContain('tracked\tcurrent: ' + 'b'.repeat(40));
    expect(fetchRequests).toEqual([
      'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/master',
    ]);
    expect(readFileSync(join(catalogRoot, 'catalog.json'), 'utf8')).toBe(
      registryBefore,
    );

    fetchRequests.length = 0;
    mockUpstream({ master: 'd'.repeat(40) });
    const changed = await runStatus('nestjs@12', '--check-upstream');
    expect(changed.exitCode).toBe(0);
    expect(changed.text).toContain(
      `tracked\tchanged: tracked ref resolves to a different commit (${'d'.repeat(40)})`,
    );
    expect(changed.text).not.toMatch(/compatible|update available/iu);
    expect(fetchRequests).toEqual([
      'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/master',
    ]);

    fetchRequests.length = 0;
    mockUpstream({}, 'master');
    const failed = await runStatus('nestjs@12', '--check-upstream');
    expect(failed.exitCode).toBe(1);
    expect(failed.text).toContain('tracked\tcheck failed:');
    expect(failed.text).toContain('503');
    expect(fetchRequests).toEqual([
      'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/master',
    ]);
  });

  it('checks all tracked refs and leaves imported snapshots visible without querying them', async () => {
    await createSnapshot('nestjs', '11', 'a'.repeat(40), {
      ref: '11.0.0',
      tracked: true,
    });
    await createSnapshot('nestjs', '12', 'b'.repeat(40), {
      ref: 'master',
      tracked: true,
    });
    await createSnapshot('imported-git', '1', 'c'.repeat(40), {
      ref: 'master',
    });

    mockUpstream({
      '11.0.0': 'a'.repeat(40),
      master: 'b'.repeat(40),
    });
    const result = await runStatus('--check-upstream');

    expect(result.exitCode).toBe(0);
    expect(fetchRequests).toEqual([
      'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/11.0.0',
      'https://api.github.com/repos/nestjs/docs.nestjs.com/commits/master',
    ]);
    expect(result.text).toContain('imported-git@1');
    expect(result.text).toContain('imported Git\tuntracked\tuntracked');
  });

  async function createSnapshot(
    source: string,
    version: string,
    revision: string,
    options: { ref: string; tracked?: boolean } | undefined = undefined,
  ): Promise<string> {
    const directory = join(root, `snapshot-${source}-${version}`);
    mkdirSync(directory, { recursive: true });
    createMcpServerTestIndex(join(directory, 'index.sqlite'), version, {
      documentationId: source,
      revision,
    });
    if (options) rewriteSnapshotProvenance(directory, options.ref, revision);
    await addSnapshot(
      directory,
      { catalogRoot, packageDataDirectory: dataDirectory },
      options?.tracked ? { trackingRecipe: `${source}@${version}` } : {},
    );
    const registry = JSON.parse(
      readFileSync(join(catalogRoot, 'catalog.json'), 'utf8'),
    ) as {
      snapshots: { source: string; version: string; directoryKey: string }[];
    };
    const pointer = registry.snapshots.find(
      (candidate) =>
        candidate.source === source && candidate.version === version,
    );
    if (!pointer)
      throw new Error(`Snapshot was not installed: ${source}@${version}`);
    return join(catalogRoot, 'snapshots', pointer.directoryKey);
  }

  function rewriteSnapshotProvenance(
    directory: string,
    ref: string,
    revision: string,
  ): void {
    const provenance = {
      kind: 'git' as const,
      repository: officialRepository,
      ref,
      revision,
    };
    const corpusPath = join(directory, 'corpus.json');
    const manifestPath = join(directory, 'manifest.json');
    const corpus = JSON.parse(
      readFileSync(corpusPath, 'utf8'),
    ) as DocumentationCorpus;
    corpus.source = provenance;
    for (const document of corpus.documents) {
      document.source.provenance = provenance;
    }
    const corpusBytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`);
    writeFileSync(corpusPath, corpusBytes);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: DocumentationCorpus['source'];
      corpus: { sha256: string };
    };
    manifest.source = provenance;
    manifest.corpus.sha256 = createHash('sha256')
      .update(corpusBytes)
      .digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async function runStatus(...args: string[]) {
    return renderStatus(parseStatusArguments(args), {
      catalogRoot,
      packageDataDirectory: dataDirectory,
      sourceBuilder,
    });
  }

  function mockUpstream(
    revisions: Record<string, string> = {},
    failedRef?: string,
  ): void {
    globalThis.fetch = (input) => {
      const url = fetchUrl(input);
      fetchRequests.push(url);
      if (!url.startsWith(apiPrefix)) {
        return Promise.reject(new Error(`Unexpected network request: ${url}`));
      }
      const ref = decodeURIComponent(url.slice(apiPrefix.length));
      if (ref === failedRef) {
        return Promise.resolve(new Response('unavailable', { status: 503 }));
      }
      return Promise.resolve(
        Response.json({ sha: revisions[ref] ?? 'f'.repeat(40) }),
      );
    };
  }
});

function fetchUrl(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
