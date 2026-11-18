import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { installTransformersRuntime } from '../../../../apps/nekosearch/src/install-transformers-runtime.js';
import {
  getRuntimeHostProblem,
  inspectRuntimeDirectory,
  resolveManagedRuntimeDirectory,
} from '../../../../apps/nekosearch/src/transformers-runtime.js';

const runtimeTest = getRuntimeHostProblem() ? it.skip : it;

describe('managed local inference runtime', () => {
  let root: string;
  let environment: NodeJS.ProcessEnv;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nekosearch-runtime-test-'));
    environment = { ...process.env, XDG_DATA_HOME: root };
    target = resolveManagedRuntimeDirectory(environment);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runtimeTest(
    'validates and promotes a pinned installation and reuses it on a retry',
    async () => {
      let installs = 0;
      const options = {
        environment,
        async installDependencies(stage: string) {
          installs++;
          expect(inspectRuntimeDirectory(target)).toBeUndefined();
          const lock: unknown = JSON.parse(
            await readFile(join(stage, 'package-lock.json'), 'utf8'),
          );
          expect(lock).toMatchObject({
            packages: {
              'node_modules/@huggingface/transformers': { version: '4.3.2' },
              'node_modules/onnxruntime-node': {
                version: '1.30.0',
                integrity: expect.stringMatching(/^sha512-/u) as string,
              },
            },
          });
          await writeRuntimePackage(
            stage,
            '@huggingface/transformers',
            '4.3.2',
            'exports.env = { version: "4.3.2" }; exports.pipeline = function () {};',
          );
          await writeRuntimePackage(
            stage,
            'onnxruntime-node',
            '1.30.0',
            'exports.InferenceSession = {};',
          );
        },
      };
      await installTransformersRuntime(options);
      expect(inspectRuntimeDirectory(target)?.available).toBe(true);
      await installTransformersRuntime(options);
      expect(installs).toBe(1);
      expect(await readdir(dirname(target))).toEqual([basename(target)]);
    },
  );

  runtimeTest(
    'cleans up an invalid staged runtime and allows another attempt',
    async () => {
      await expect(
        installTransformersRuntime({
          environment,
          async installDependencies(stage) {
            await writeRuntimePackage(
              stage,
              '@huggingface/transformers',
              '4.3.2',
              'exports.env = {};',
            );
          },
        }),
      ).rejects.toThrow(/staged inference runtime failed verification/u);
      expect(inspectRuntimeDirectory(target)).toBeUndefined();
      expect(await readdir(dirname(target))).toEqual([]);
    },
  );
});

async function writeRuntimePackage(
  stage: string,
  name: string,
  version: string,
  source: string,
): Promise<void> {
  const folder = join(stage, 'node_modules', name);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({ name, version, main: 'index.cjs' }),
  );
  await writeFile(join(folder, 'index.cjs'), source);
}
