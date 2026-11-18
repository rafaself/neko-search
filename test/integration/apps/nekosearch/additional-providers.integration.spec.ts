import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { NekosearchStdioCommand } from '../../../../apps/nekosearch/src/mcp-command.js';
import type { ProviderCommandRunner } from '../../../../apps/nekosearch/src/providers/provider-runner.js';
import {
  configureSetupClient,
  inspectSetupClients,
  removeSetupClient,
} from '../../../../apps/nekosearch/src/setup-clients.js';

describe('Codex, Claude Code, and Cursor provider setup', () => {
  let root: string;
  let server: NekosearchStdioCommand;
  let claudePath: string;
  let cursorPath: string;
  let calls: string[][];
  let codexServers: unknown[];
  let runner: ProviderCommandRunner;
  const unrelated = { docs: { url: 'https://example.invalid/mcp' } };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nekosearch clients '));
    server = {
      command: join(root, 'Node JS'),
      args: [join(root, 'CLI path.js'), 'serve'],
    };
    claudePath = join(root, 'claude-profile', '.claude.json');
    cursorPath = join(root, '.cursor', 'mcp.json');
    await mkdir(join(root, 'claude-profile'));
    calls = [];
    codexServers = [];
    runner = {
      resolve: (name) =>
        ['codex', 'claude', 'cursor-agent'].includes(name)
          ? join(root, name)
          : undefined,
      async run(executable, args, options) {
        calls.push(args);
        const [group, verb] = args;
        expect(group).toBe('mcp');
        expect(options.cwd).not.toBe(process.cwd());
        if (executable === join(root, 'codex')) {
          if (verb === 'list')
            return { stdout: JSON.stringify(codexServers), stderr: '' };
          if (verb === 'add') {
            expect(args).toEqual([
              'mcp',
              'add',
              'nekosearch',
              '--',
              server.command,
              ...server.args,
            ]);
            codexServers.push({
              name: 'nekosearch',
              enabled: true,
              transport: { type: 'stdio', ...server },
            });
          } else {
            expect(args).toEqual(['mcp', 'remove', 'nekosearch']);
            codexServers = [];
          }
        } else {
          expect(executable).toBe(join(root, 'claude'));
          expect(options.environment.CLAUDE_CONFIG_DIR).toBe(
            join(root, 'claude-profile'),
          );
          if (verb === 'add') {
            expect(args).toEqual([
              'mcp',
              'add',
              '--scope',
              'user',
              '--transport',
              'stdio',
              'nekosearch',
              '--',
              server.command,
              ...server.args,
            ]);
            await writeFile(
              claudePath,
              JSON.stringify({
                mcpServers: {
                  ...unrelated,
                  nekosearch: { type: 'stdio', env: {}, ...server },
                },
              }),
            );
          } else {
            expect(args).toEqual([
              'mcp',
              'remove',
              '--scope',
              'user',
              'nekosearch',
            ]);
            await writeFile(
              claudePath,
              JSON.stringify({ mcpServers: unrelated }),
            );
          }
        }
        return { stdout: '', stderr: '' };
      },
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function options() {
    return {
      homeDirectory: root,
      environment: {
        CLAUDE_CONFIG_DIR: join(root, 'claude-profile'),
        PATH: '',
      },
      serverCommand: server,
      providerRunner: runner,
    };
  }

  it('offers all three providers without connecting to Claude Code or Cursor MCP servers', async () => {
    const statuses = await inspectSetupClients(options());
    expect(statuses.map(({ id, state }) => [id, state])).toEqual([
      ['codex', 'ready'],
      ['claude-code', 'ready'],
      ['cursor', 'ready'],
    ]);
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });

  it.each(['codex', 'claude-code', 'cursor'])(
    'registers %s, treats an exact match as unchanged, and removes only that entry',
    async (provider) => {
      if (provider === 'cursor') {
        await mkdir(join(root, '.cursor'));
        await writeFile(
          cursorPath,
          JSON.stringify({ other: true, mcpServers: unrelated }),
        );
      }
      await expect(configureSetupClient(provider, options())).resolves.toBe(
        'added',
      );
      await expect(configureSetupClient(provider, options())).resolves.toBe(
        'unchanged',
      );
      await expect(removeSetupClient(provider, options())).resolves.toBe(
        'removed',
      );
      await expect(removeSetupClient(provider, options())).resolves.toBe(
        'unchanged',
      );
      if (provider === 'cursor') {
        expect(JSON.parse(await readFile(cursorPath, 'utf8'))).toEqual({
          other: true,
          mcpServers: unrelated,
        });
      } else if (provider === 'claude-code') {
        expect(JSON.parse(await readFile(claudePath, 'utf8'))).toEqual({
          mcpServers: unrelated,
        });
      }
    },
  );

  it('preserves customized and conflicting registrations', async () => {
    await mkdir(join(root, '.cursor'));
    const cursorSource = JSON.stringify({
      mcpServers: {
        nekosearch: { ...server, env: { NEKOSEARCH_MODEL_DIR: 'custom' } },
      },
    });
    const claudeSource = JSON.stringify({
      mcpServers: {
        nekosearch: { type: 'http', url: 'https://example.invalid/mcp' },
      },
    });
    await writeFile(cursorPath, cursorSource);
    await writeFile(claudePath, claudeSource);
    codexServers = [
      {
        name: 'nekosearch',
        enabled: false,
        transport: { type: 'stdio', ...server },
      },
    ];
    for (const provider of ['codex', 'claude-code', 'cursor']) {
      await expect(configureSetupClient(provider, options())).rejects.toThrow(
        /different nekosearch/u,
      );
      await expect(removeSetupClient(provider, options())).rejects.toThrow(
        /different nekosearch/u,
      );
    }
    expect(await readFile(cursorPath, 'utf8')).toBe(cursorSource);
    expect(await readFile(claudePath, 'utf8')).toBe(claudeSource);
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'list', '--json'],
    ]);
  });

  it('preserves a malformed or linked Cursor configuration', async () => {
    await mkdir(join(root, '.cursor'));
    await writeFile(cursorPath, 'malformed');
    await expect(configureSetupClient('cursor', options())).rejects.toThrow(
      /JSON object/u,
    );
    expect(await readFile(cursorPath, 'utf8')).toBe('malformed');
    if (process.platform === 'win32') return;
    const external = join(root, 'other.json');
    await writeFile(external, '{}');
    await rm(cursorPath);
    await symlink(external, cursorPath);
    await expect(configureSetupClient('cursor', options())).rejects.toThrow(
      /regular configuration file/u,
    );
    expect(await readFile(external, 'utf8')).toBe('{}');
  });
});
