import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(
  new URL(
    '../../../../scripts/validation/validate-qwen3-embedding.mjs',
    import.meta.url,
  ),
);

const runRealInference = process.env.NEKOSEARCH_RUN_QWEN3_INTEGRATION === '1';
const realInferenceTest = runRealInference ? it : it.skip;

describe('real local Qwen3 inference', () => {
  realInferenceTest(
    'runs the offline local inference validator in a native Node process',
    async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [validatorPath],
        {
          cwd: process.env.NEKOSEARCH_QWEN3_RUNTIME_CWD ?? process.cwd(),
          env: process.env,
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(stdout).toContain('Validated local Qwen3 tokenizer and inference');
      expect(stdout).toContain('What is the capital of China?');
      expect(stdout).toContain('Explain gravity');
      expect(stdout).toContain('Hybrid Search over offline MCP stdio');
    },
    120_000,
  );
});
