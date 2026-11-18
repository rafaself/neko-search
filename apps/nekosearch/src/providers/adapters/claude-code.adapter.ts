import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { providerCommandRunner } from '../provider-runner.js';
import type {
  McpProviderAdapter,
  McpProviderRuntime,
} from '../provider.types.js';
import {
  assertServerCommand,
  matchesUserRegistration,
  namedServer,
  NEKOSEARCH_SERVER_NAME,
  objectSchema,
  readUserJson,
  userRegistration,
  userServerEntries,
} from '../user-registration.js';

export function createClaudeCodeAdapter(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter {
  const environment = runtime.environment ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const home = runtime.homeDirectory ?? homedir();
  const runner = runtime.runner ?? providerCommandRunner;
  const configRoot = environment.CLAUDE_CONFIG_DIR
    ? resolve(environment.CLAUDE_CONFIG_DIR)
    : home;
  const path = join(configRoot, '.claude.json');
  const detect = () => runner.resolve('claude', environment, platform);

  async function run(args: string[]) {
    const executable = detect();
    if (!executable)
      throw new Error('Claude Code CLI was not detected on PATH');
    await runner.run(executable, args, {
      environment: {
        ...environment,
        ...(environment.CLAUDE_CONFIG_DIR && { CLAUDE_CONFIG_DIR: configRoot }),
      },
      platform,
      cwd: tmpdir(),
    });
  }

  const adapter: McpProviderAdapter = {
    id: 'claude-code',
    label: 'Claude Code',
    target: `Claude Code user MCP registry (${path})`,
    detect,
    async inspect() {
      // Claude Code's list/get commands health-check servers. The user file
      // provides the explicit scope without launching or connecting to them.
      const { data } = await readUserJson(path);
      const entry = namedServer(userServerEntries(data));
      if (!entry) return [];
      const env = entry.env === undefined ? {} : objectSchema.parse(entry.env);
      return [
        userRegistration(
          entry,
          path,
          entry.type === 'stdio' ||
            (entry.type === undefined && 'command' in entry),
          Object.keys(env).length > 0 ||
            Object.keys(entry).some(
              (key) => !['type', 'command', 'args', 'env'].includes(key),
            ),
        ),
      ];
    },
    async add(server) {
      assertServerCommand(server);
      if ((await adapter.inspect()).length !== 0)
        throw new Error(
          'Claude Code already has a nekosearch user MCP registration',
        );
      await run([
        'mcp',
        'add',
        '--scope',
        'user',
        '--transport',
        'stdio',
        NEKOSEARCH_SERVER_NAME,
        '--',
        server.command,
        ...server.args,
      ]);
      if (!matchesUserRegistration((await adapter.inspect())[0], server))
        throw new Error(
          'Claude Code did not save the requested NekoSearch user registration',
        );
    },
    async remove(name, server) {
      assertServerCommand(server);
      if (
        name !== NEKOSEARCH_SERVER_NAME ||
        !matchesUserRegistration((await adapter.inspect())[0], server)
      )
        throw new Error(
          'Refusing to remove an unverified Claude Code user registration',
        );
      await run(['mcp', 'remove', '--scope', 'user', name]);
      if ((await adapter.inspect()).length !== 0)
        throw new Error(
          'Claude Code still has a nekosearch user registration after removal',
        );
    },
  };
  return adapter;
}
