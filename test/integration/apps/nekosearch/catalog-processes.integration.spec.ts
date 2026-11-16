import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpServerTestIndex } from '../../../fixtures/mcp-server-index.js';
import {
  addSnapshot,
  listCatalogIndexes,
  type SnapshotIdentity,
} from '../../../../src/apps/nekosearch/catalog.js';

const dataDirectory = resolve(process.cwd(), 'data');
const catalogModuleUrl = pathToFileURL(
  resolve(process.cwd(), 'src/apps/nekosearch/catalog.ts'),
).href;

describe('NekoSearch catalog writes across processes', () => {
  let root: string;
  let catalogRoot: string;
  let runnerPath: string;

  beforeAll(() => {
    const engineEntry = resolve(
      process.cwd(),
      'packages/documentation-engine/dist/domain/documentation-index-manifest.schemas.js',
    );
    if (!existsSync(engineEntry)) {
      execFileSync(
        process.execPath,
        [
          'node_modules/typescript/bin/tsc',
          '-p',
          'packages/documentation-engine/tsconfig.build.json',
        ],
        { cwd: process.cwd(), stdio: 'pipe' },
      );
    }
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch-catalog-processes-'));
    catalogRoot = join(root, 'catalog');
    runnerPath = join(root, 'catalog-writer.mjs');
    await writeFile(
      runnerPath,
      `import { access, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { addSnapshot, updateSnapshot } from ${JSON.stringify(catalogModuleUrl)};
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (input.readyPath) await writeFile(input.readyPath, 'ready');
if (input.startPath) {
  while (true) {
    try { await access(input.startPath); break; }
    catch { await delay(5); }
  }
}
if (input.delayMs) await delay(input.delayMs);
try {
  const options = { catalogRoot: input.catalogRoot, packageDataDirectory: input.packageDataDirectory };
  const result = input.operation === 'add'
    ? await addSnapshot(input.snapshotDirectory, options)
    : await updateSnapshot(input.snapshotDirectory, options, { expectedCurrent: input.expectedCurrent });
  const entry = 'entry' in result ? result.entry : result;
  process.stdout.write(JSON.stringify({ ok: true, revision: entry.revision, changed: 'changed' in result ? result.changed : true }) + '\\n');
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + '\\n');
  process.exitCode = 1;
}
`,
      'utf8',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preserves two distinct concurrent installs from separate processes', async () => {
    const first = createSnapshot('docs-alpha', '1', 'alpha-r1');
    const second = createSnapshot('docs-beta', '1', 'beta-r1');
    const [firstResult, secondResult] = await Promise.all([
      runWriter({ operation: 'add', snapshotDirectory: first }),
      runWriter({ operation: 'add', snapshotDirectory: second }),
    ]);
    if (firstResult.code !== 0) {
      throw new Error(
        `First writer failed (code=${firstResult.code}, signal=${firstResult.signal}): ${firstResult.stderr}${firstResult.stdout}`,
      );
    }
    if (secondResult.code !== 0) {
      throw new Error(
        `Second writer failed (code=${secondResult.code}, signal=${secondResult.signal}): ${secondResult.stderr}${secondResult.stdout}`,
      );
    }

    const installed = (
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      })
    )
      .filter((entry) => entry.status === 'installed')
      .map((entry) => `${entry.source}@${entry.version}`)
      .sort();
    expect(installed).toEqual(['docs-alpha@1', 'docs-beta@1']);
  });

  it('rejects a stale overlapping update instead of replacing the winner', async () => {
    const initial = createSnapshot('docs-shared', '1', 'shared-r1');
    await addSnapshot(initial, {
      catalogRoot,
      packageDataDirectory: dataDirectory,
    });
    const current = (
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      })
    ).find((entry) => entry.source === 'docs-shared');
    if (!current) throw new Error('Seed snapshot was not installed');
    const expectedCurrent: SnapshotIdentity = {
      source: current.source,
      version: current.version,
      revision: current.revision,
      directoryKey: basename(dirname(current.databasePath)),
    };
    const fast = createSnapshot('docs-shared', '1', 'shared-r2');
    const stale = createSnapshot('docs-shared', '1', 'shared-r3');
    const startPath = join(root, 'start');
    const fastReadyPath = join(root, 'fast-ready');
    const staleReadyPath = join(root, 'stale-ready');
    const fastProcess = spawnWriter({
      operation: 'update',
      snapshotDirectory: fast,
      expectedCurrent,
      readyPath: fastReadyPath,
      startPath,
      delayMs: 0,
    });
    const staleProcess = spawnWriter({
      operation: 'update',
      snapshotDirectory: stale,
      expectedCurrent,
      readyPath: staleReadyPath,
      startPath,
      delayMs: 300,
    });

    await waitForFile(fastReadyPath);
    await waitForFile(staleReadyPath);
    await writeFile(startPath, 'go');
    const [fastResult, staleResult] = await Promise.all([
      waitForProcess(fastProcess),
      waitForProcess(staleProcess),
    ]);

    expect(fastResult.code).toBe(0);
    expect(staleResult.code).toBe(1);
    expect(`${staleResult.stderr}${staleResult.stdout}`).toMatch(
      /changed while the update was being built/u,
    );
    const active = (
      await listCatalogIndexes({
        catalogRoot,
        packageDataDirectory: dataDirectory,
      })
    ).find((entry) => entry.source === 'docs-shared');
    expect(active?.revision).toBe('shared-r2');
  }, 20_000);

  function createSnapshot(
    source: string,
    version: string,
    revision: string,
  ): string {
    const directory = join(root, `${source}-${revision}`);
    mkdirSync(directory, { recursive: true });
    createMcpServerTestIndex(join(directory, 'index.sqlite'), version, {
      documentationId: source,
      revision,
    });
    return directory;
  }

  async function runWriter(input: Record<string, unknown>) {
    return waitForProcess(spawnWriter(input));
  }

  function spawnWriter(input: Record<string, unknown>): ChildProcess {
    const inputPath = join(
      root,
      `input-${Math.random().toString(16).slice(2)}.json`,
    );
    writeFileSync(
      inputPath,
      JSON.stringify({
        ...input,
        catalogRoot,
        packageDataDirectory: dataDirectory,
      }),
    );
    return spawn(
      process.execPath,
      ['--experimental-strip-types', runnerPath, inputPath],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }
});

function waitForProcess(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolvePromise({ code, signal, stdout, stderr }),
    );
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw new Error(`Timed out waiting for process readiness file ${path}`);
}
