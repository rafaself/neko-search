import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const appPath = 'apps/nekosearch';
const enginePath = 'packages/documentation-engine';
const app = join(root, appPath);
const engine = join(root, enginePath);

/** Build the production package tree independently of npm's workspace hoisting. */
export async function stageNekosearchPackage(stage, environment) {
  const [appManifest, engineManifest, workspaceLock] = await Promise.all([
    readJson(join(app, 'package.json')),
    readJson(join(engine, 'package.json')),
    readJson(join(root, 'package-lock.json')),
  ]);
  assert.equal(
    appManifest.dependencies[engineManifest.name],
    engineManifest.version,
  );
  assert.ok(appManifest.bundleDependencies.includes(engineManifest.name));

  await mkdir(stage, { recursive: true });
  const maintenance = join(app, 'dist/apps/nekosearch/maintenance');
  const engineDestination = join(stage, enginePath);
  await Promise.all([
    cp(join(app, 'dist'), join(stage, 'dist'), {
      recursive: true,
      filter: (source) => source !== maintenance,
    }),
    cp(join(app, 'data/mcp-protocol'), join(stage, 'data/mcp-protocol'), {
      recursive: true,
    }),
    ...['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'].map((name) =>
      copyFile(join(root, name), join(stage, name)),
    ),
    cp(join(root, 'licenses'), join(stage, 'licenses'), { recursive: true }),
    ...['package.json', ...engineManifest.files].map(async (path) => {
      const destination = join(engineDestination, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(engine, path), destination);
    }),
    writeJson(join(stage, 'package.json'), {
      ...appManifest,
      workspaces: [enginePath],
    }),
    writeJson(join(stage, 'package-lock.json'), {
      name: appManifest.name,
      version: appManifest.version,
      lockfileVersion: workspaceLock.lockfileVersion,
      requires: true,
      packages: {
        '': { ...workspaceLock.packages[appPath], workspaces: [enginePath] },
        [enginePath]: workspaceLock.packages[enginePath],
        ...Object.fromEntries(
          Object.entries(workspaceLock.packages).filter(
            ([path, entry]) =>
              path.startsWith('node_modules/') &&
              (!entry.link || entry.resolved === enginePath),
          ),
        ),
      },
    }),
  ]);

  // npm must see the engine and its complete locked production dependency
  // tree while collecting bundled dependencies. This also preserves npm's
  // dependency layout when an existing installation upgrades the CLI.
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: stage, env: environment, stdio: 'inherit' },
  );
  await copyFile(join(app, 'package.json'), join(stage, 'package.json'));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function writeJson(path, value) {
  return writeFile(path, JSON.stringify(value));
}
