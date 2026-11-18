import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NekosearchStdioCommand } from '../../mcp-command.js';
import { providerCommandRunner } from '../provider-runner.js';
import type {
  McpProviderAdapter,
  McpProviderRuntime,
} from '../provider.types.js';
import {
  assertServerCommand,
  isMissingFile,
  matchesUserRegistration,
  namedServer,
  NEKOSEARCH_SERVER_NAME,
  readUserJson,
  userRegistration,
  userServerEntries,
} from '../user-registration.js';

export function createCursorAdapter(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter {
  const environment = runtime.environment ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const home = runtime.homeDirectory ?? homedir();
  const runner = runtime.runner ?? providerCommandRunner;
  const directory = join(home, '.cursor');
  const path = join(directory, 'mcp.json');

  function inspectEntry(data: Record<string, unknown>) {
    const entry = namedServer(userServerEntries(data));
    return (
      entry &&
      userRegistration(
        entry,
        path,
        'command' in entry && !('url' in entry),
        Object.keys(entry).some((key) => !['command', 'args'].includes(key)),
      )
    );
  }

  async function inspectDirectory(): Promise<void> {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Expected a regular directory at ${directory}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async function update(
    server: NekosearchStdioCommand,
    action: 'add' | 'remove',
  ) {
    assertServerCommand(server);
    if (action === 'add')
      await mkdir(directory, { recursive: true, mode: 0o700 });
    await inspectDirectory();
    const lockPath = join(directory, '.nekosearch-mcp.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      const { data, source, mode } = await readUserJson(path);
      const existing = inspectEntry(data);
      const entries = userServerEntries(data);
      if (action === 'add') {
        if (existing)
          throw new Error('Cursor already has a nekosearch MCP registration');
        entries[NEKOSEARCH_SERVER_NAME] = {
          command: server.command,
          args: server.args,
        };
      } else {
        if (!matchesUserRegistration(existing, server))
          throw new Error(
            'Refusing to remove an unverified Cursor registration',
          );
        delete entries[NEKOSEARCH_SERVER_NAME];
      }

      const temporaryDirectory = await mkdtemp(
        join(directory, '.nekosearch-mcp-'),
      );
      try {
        const next = join(temporaryDirectory, 'mcp.json');
        await writeFile(
          next,
          JSON.stringify({ ...data, mcpServers: entries }, null, 2) + '\n',
          { mode, flag: 'wx' },
        );
        if ((await readUserJson(path)).source !== source)
          throw new Error(
            'Cursor MCP configuration changed during setup. Retry the operation.',
          );
        await rename(next, path);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  return {
    id: 'cursor',
    label: 'Cursor',
    target: `Cursor user MCP configuration (${path})`,
    detect: () =>
      runner.resolve('cursor', environment, platform) ??
      runner.resolve('cursor-agent', environment, platform),
    async inspect() {
      await inspectDirectory();
      const { data } = await readUserJson(path);
      const registration = inspectEntry(data);
      return registration ? [registration] : [];
    },
    add: (server) => update(server, 'add'),
    async remove(name, server) {
      if (name !== NEKOSEARCH_SERVER_NAME)
        throw new Error(
          'Cursor removal is limited to the nekosearch registration',
        );
      await update(server, 'remove');
    },
  };
}
