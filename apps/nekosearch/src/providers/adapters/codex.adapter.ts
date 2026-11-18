import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { providerCommandRunner } from '../provider-runner.js';
import type {
  McpProviderAdapter,
  McpProviderRuntime,
} from '../provider.types.js';
import {
  assertServerCommand,
  matchesUserRegistration,
  NEKOSEARCH_SERVER_NAME,
  objectSchema,
  userRegistration,
} from '../user-registration.js';

const inventorySchema = z.array(
  z.looseObject({
    name: z.string(),
    enabled: z.boolean().optional(),
    transport: objectSchema,
  }),
);

export function createCodexAdapter(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter {
  const environment = runtime.environment ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const runner = runtime.runner ?? providerCommandRunner;
  const target = 'Codex user MCP registry (managed by `codex mcp`)';
  const detect = () => runner.resolve('codex', environment, platform);

  async function run(args: string[]) {
    const executable = detect();
    if (!executable) throw new Error('Codex CLI was not detected on PATH');
    // Isolate the user inventory from the invoking workspace's configuration.
    const cwd = await mkdtemp(join(tmpdir(), 'nekosearch-codex-'));
    try {
      return await runner.run(executable, args, { environment, platform, cwd });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  const adapter: McpProviderAdapter = {
    id: 'codex',
    label: 'Codex',
    target,
    detect,
    async inspect() {
      const { stdout } = await run(['mcp', 'list', '--json']);
      const result = inventorySchema.safeParse(JSON.parse(stdout) as unknown);
      if (!result.success)
        throw new Error('Codex returned an unsupported MCP inventory');
      return result.data
        .filter(({ name }) => name === NEKOSEARCH_SERVER_NAME)
        .map((entry) =>
          userRegistration(
            entry.transport,
            target,
            entry.transport.type === 'stdio',
            entry.enabled === false ||
              entry.disabled_reason != null ||
              entry.startup_timeout_sec != null ||
              entry.tool_timeout_sec != null ||
              entry.transport.cwd != null ||
              hasEntries(entry.transport.env) ||
              hasEntries(entry.transport.env_vars) ||
              hasEntries(entry.enabled_tools) ||
              hasEntries(entry.disabled_tools),
          ),
        );
    },
    async add(server) {
      assertServerCommand(server);
      if ((await adapter.inspect()).length !== 0)
        throw new Error('Codex already has a nekosearch MCP registration');
      await run([
        'mcp',
        'add',
        NEKOSEARCH_SERVER_NAME,
        '--',
        server.command,
        ...server.args,
      ]);
      const registrations = await adapter.inspect();
      if (
        registrations.length !== 1 ||
        !matchesUserRegistration(registrations[0], server)
      )
        throw new Error(
          'Codex did not report the requested NekoSearch registration',
        );
    },
    async remove(name, server) {
      assertServerCommand(server);
      const registrations = await adapter.inspect();
      if (
        name !== NEKOSEARCH_SERVER_NAME ||
        registrations.length !== 1 ||
        !matchesUserRegistration(registrations[0], server)
      )
        throw new Error('Refusing to remove an unverified Codex registration');
      await run(['mcp', 'remove', name]);
      if ((await adapter.inspect()).length !== 0)
        throw new Error(
          'Codex still reports a nekosearch registration after removal',
        );
    },
  };
  return adapter;
}

function hasEntries(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
}
