import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  getRuntimeHostProblem,
  inspectRuntimeDirectory,
  inspectPersistentTransformersRuntime,
  resolveManagedRuntimeDirectory,
  TRANSFORMERS_VERSION,
} from './transformers-runtime.js';

const runFile = promisify(execFile);
const LOCK_FILE = new URL('./semantic-runtime-lock.json', import.meta.url);

interface RuntimeInstallOptions {
  environment?: NodeJS.ProcessEnv;
  progress?: (message: string) => void;
  installDependencies?: (
    stage: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

/** Provision inference only during an explicit model installation. */
export async function installTransformersRuntime(
  options: RuntimeInstallOptions = {},
): Promise<void> {
  const hostProblem = getRuntimeHostProblem();
  if (hostProblem) throw new Error(hostProblem);

  const environment = options.environment ?? process.env;
  if (inspectPersistentTransformersRuntime(environment)?.available) return;

  const target = resolveManagedRuntimeDirectory(environment);
  if (await exists(target)) {
    throw new Error(
      `The managed inference runtime at ${target} is incomplete or invalid. Move that directory out of the way and retry the installation.`,
    );
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, '.installing-'));
  try {
    options.progress?.('Installing the pinned local inference runtime');
    await writeFile(
      join(stage, 'package.json'),
      JSON.stringify({
        name: 'nekosearch-semantic-runtime',
        version: '1.0.0',
        private: true,
        dependencies: { '@huggingface/transformers': TRANSFORMERS_VERSION },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      join(stage, 'package-lock.json'),
      await readFile(LOCK_FILE),
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    const installDependencies = options.installDependencies ?? installWithNpm;
    await installDependencies(stage, environment);

    const installed = inspectRuntimeDirectory(stage);
    if (!installed?.available) {
      throw new Error(
        `The staged inference runtime failed verification. ${installed?.detail ?? 'Transformers.js is missing.'}`,
      );
    }
    try {
      await rename(stage, target);
    } catch (error) {
      // A concurrent installer may have finished while this one downloaded.
      if (
        !(await exists(target)) ||
        !inspectRuntimeDirectory(target)?.available
      )
        throw error;
    }
    options.progress?.('Local inference runtime installed and verified');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function installWithNpm(
  stage: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    // This CPU runtime uses the native libraries in the npm archives. The
    // integrity-pinned lockfile lets npm install them without lifecycle scripts.
    await runFile(
      'npm',
      [
        'ci',
        '--prefix',
        stage,
        '--global=false',
        '--workspaces=false',
        '--ignore-scripts',
        '--include=optional',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: stage,
        env: environment,
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (cause) {
    throw new Error(
      'Could not install the pinned inference runtime with npm. Check that npm is on PATH, the registry is reachable, and disk space is available. Then retry.',
      { cause },
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}
