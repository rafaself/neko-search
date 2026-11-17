import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import {
  configureSetupClient,
  inspectSetupClients,
  removeSetupClient,
} from '../../../../src/apps/nekosearch/setup-clients.js';
import type { NekosearchStdioCommand } from '../../../../src/apps/nekosearch/mcp-command.js';

let root: string;
let homeDirectory: string;
let command: NekosearchStdioCommand;

describe('NekoSearch setup MCP client adapters', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch setup clients with spaces '));
    homeDirectory = join(root, 'user home');
    mkdirSync(homeDirectory);
    command = {
      command: join(root, 'node executable with spaces'),
      args: [
        join(root, 'installed package', 'dist', 'apps', 'nekosearch', 'cli.js'),
        'serve',
      ],
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('preserves JSONC settings when adding and removing its registration', async () => {
    const configPath = join(homeDirectory, '.cursor', 'mcp.json');
    mkdirSync(join(homeDirectory, '.cursor'));
    const original = [
      '{',
      '  // Keep this comment.',
      '  "unrelated": { "enabled": true },',
      '  "mcpServers": { "existing": { "command": "other" } }',
      '}',
      '',
    ].join('\n');
    writeFileSync(configPath, original);

    await expect(configureSetupClient('cursor', options())).resolves.toBe(
      'added',
    );

    const updated = readFileSync(configPath, 'utf8');
    expect(updated).toContain('// Keep this comment.');
    expect(updated).toContain('"unrelated": { "enabled": true }');
    expect(parseJson(updated)).toMatchObject({
      unrelated: { enabled: true },
      mcpServers: {
        existing: { command: 'other' },
        nekosearch: {
          type: 'stdio',
          command: command.command,
          args: command.args,
        },
      },
    });
    await expect(configureSetupClient('cursor', options())).resolves.toBe(
      'unchanged',
    );
    const cursor = (await inspectSetupClients(options())).find(
      ({ id }) => id === 'cursor',
    );
    expect(cursor).toMatchObject({
      state: 'already-configured',
      application: 'not-detected',
      configuration: 'available',
      registration: 'configured',
    });
    expect(readFileSync(configPath, 'utf8')).toBe(updated);
    expect(existsSync(`${configPath}.nekosearch-setup.lock`)).toBe(false);
    expect(readdirNames(join(homeDirectory, '.cursor'))).toEqual(['mcp.json']);

    await expect(removeSetupClient('cursor', options())).resolves.toBe(
      'removed',
    );
    const removed = readFileSync(configPath, 'utf8');
    expect(removed).toContain('// Keep this comment.');
    expect(removed).toContain('"unrelated": { "enabled": true }');
    expect(parseJson(removed)).toMatchObject({
      unrelated: { enabled: true },
      mcpServers: { existing: { command: 'other' } },
    });
    expect(parseJson(removed)).not.toHaveProperty('mcpServers.nekosearch');
    await expect(removeSetupClient('cursor', options())).resolves.toBe(
      'unchanged',
    );
  });

  it('does not replace conflicting or unparsable JSONC entries', async () => {
    const configPath = join(homeDirectory, '.cursor', 'mcp.json');
    mkdirSync(join(homeDirectory, '.cursor'));
    const conflict =
      '{\n  "mcpServers": { "nekosearch": { "command": "other" } }\n}\n';
    writeFileSync(configPath, conflict);
    await expect(configureSetupClient('cursor', options())).rejects.toThrow(
      /different nekosearch MCP entry/u,
    );
    await expect(removeSetupClient('cursor', options())).rejects.toThrow(
      /no longer matches this NekoSearch setup/u,
    );
    expect(readFileSync(configPath, 'utf8')).toBe(conflict);

    const malformed = '{\n  "mcpServers": {\n';
    writeFileSync(configPath, malformed);
    const statuses = await inspectSetupClients(options());
    expect(statuses.find(({ id }) => id === 'cursor')).toMatchObject({
      state: 'conflict',
      application: 'not-detected',
      configuration: 'unsafe',
      registration: 'unknown',
    });
    await expect(configureSetupClient('cursor', options())).rejects.toThrow(
      /Cannot safely edit/u,
    );
    expect(readFileSync(configPath, 'utf8')).toBe(malformed);
  });

  it('uses the existing OpenCode JSONC user file and preserves its comments', async () => {
    const directory = join(homeDirectory, '.config', 'opencode');
    mkdirSync(directory, { recursive: true });
    const configPath = join(directory, 'opencode.jsonc');
    writeFileSync(configPath, '{\n  // OpenCode note.\n  "theme": "dark"\n}\n');

    await expect(configureSetupClient('opencode', options())).resolves.toBe(
      'added',
    );

    const updated = readFileSync(configPath, 'utf8');
    expect(updated).toContain('// OpenCode note.');
    expect(parseJson(updated)).toMatchObject({
      theme: 'dark',
      mcp: {
        servers: {
          nekosearch: {
            type: 'local',
            command: [command.command, ...command.args],
          },
        },
      },
    });
    expect(existsSync(join(directory, 'opencode.json'))).toBe(false);
  });

  it('adds Grok Build CLI TOML without rewriting its comments or other tables', async () => {
    const grokHome = join(root, 'Grok profile with spaces');
    mkdirSync(grokHome);
    const configPath = join(grokHome, 'config.toml');
    const original = '# Keep this TOML comment.\n[other]\nvalue = "retained"\n';
    writeFileSync(configPath, original);

    await expect(
      configureSetupClient('grok-build', options({ GROK_HOME: grokHome })),
    ).resolves.toBe('added');

    const updated = readFileSync(configPath, 'utf8');
    expect(updated.startsWith(original)).toBe(true);
    expect(parseToml(updated)).toMatchObject({
      other: { value: 'retained' },
      mcp_servers: {
        nekosearch: { command: command.command, args: command.args },
      },
    });
    await expect(
      configureSetupClient('grok-build', options({ GROK_HOME: grokHome })),
    ).resolves.toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(updated);
    await expect(
      removeSetupClient('grok-build', options({ GROK_HOME: grokHome })),
    ).resolves.toBe('removed');
    const removed = readFileSync(configPath, 'utf8');
    expect(parseToml(removed)).toMatchObject({
      other: { value: 'retained' },
    });
    expect(parseToml(removed)).not.toHaveProperty('mcp_servers.nekosearch');
    expect(removed).toContain('# Keep this TOML comment.');
  });

  it('uses the shared Copilot CLI and VS Code Copilot Global user config', async () => {
    const copilotHome = join(root, 'Copilot home with spaces');
    mkdirSync(copilotHome);
    const configPath = join(copilotHome, 'mcp-config.json');
    writeFileSync(
      configPath,
      '{ "mcpServers": { "other": { "type": "local" } } }\n',
    );

    await expect(
      configureSetupClient(
        'github-copilot',
        options({ COPILOT_HOME: copilotHome }),
      ),
    ).resolves.toBe('added');

    expect(parseJson(readFileSync(configPath, 'utf8'))).toMatchObject({
      mcpServers: {
        other: { type: 'local' },
        nekosearch: {
          type: 'local',
          command: command.command,
          args: command.args,
          tools: ['*'],
        },
      },
    });
  });

  it('writes and reuses the documented user config for remaining automatic adapters', async () => {
    const claudeConfigDirectory = join(root, 'Claude config directory');
    const clineConfig = join(root, 'Cline config with spaces.json');
    const xdgConfigDirectory = join(root, 'XDG config');
    const cases = [
      {
        id: 'claude-code',
        filePath: join(claudeConfigDirectory, '.claude.json'),
        rootKey: 'mcpServers',
        environment: { CLAUDE_CONFIG_DIR: claudeConfigDirectory },
      },
      {
        id: 'cline',
        filePath: clineConfig,
        rootKey: 'mcpServers',
        environment: { CLINE_MCP_SETTINGS_PATH: clineConfig },
      },
      {
        id: 'kiro',
        filePath: join(homeDirectory, '.kiro', 'settings', 'mcp.json'),
        rootKey: 'mcpServers',
        environment: {},
      },
      {
        id: 'zed',
        filePath: join(xdgConfigDirectory, 'zed', 'settings.json'),
        rootKey: 'context_servers',
        environment: { XDG_CONFIG_HOME: xdgConfigDirectory },
      },
      {
        id: 'junie',
        filePath: join(homeDirectory, '.junie', 'mcp', 'mcp.json'),
        rootKey: 'mcpServers',
        environment: {},
      },
      {
        id: 'antigravity',
        filePath: join(homeDirectory, '.gemini', 'config', 'mcp_config.json'),
        rootKey: 'mcpServers',
        environment: {},
      },
    ] as const;

    for (const adapter of cases) {
      const adapterOptions = options(adapter.environment);
      await expect(
        configureSetupClient(adapter.id, adapterOptions),
      ).resolves.toBe('added');
      expect(parseJson(readFileSync(adapter.filePath, 'utf8'))).toMatchObject({
        [adapter.rootKey]: {
          nekosearch: {
            command: command.command,
            args: command.args,
          },
        },
      });
      const configuredText = readFileSync(adapter.filePath, 'utf8');
      await expect(
        configureSetupClient(adapter.id, adapterOptions),
      ).resolves.toBe('unchanged');
      expect(readFileSync(adapter.filePath, 'utf8')).toBe(configuredText);
    }
  });

  it('detects Antigravity through the documented agy command when it is a symlink', async () => {
    const binDirectory = join(root, 'bin');
    mkdirSync(binDirectory);
    const actualExecutable = join(binDirectory, 'actual agy executable');
    writeFileSync(actualExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(actualExecutable, 0o755);
    symlinkSync(actualExecutable, join(binDirectory, 'agy'));

    const statuses = await inspectSetupClients({
      homeDirectory,
      environment: { PATH: binDirectory },
      platform: 'linux',
      serverCommand: command,
    });

    expect(statuses.find(({ id }) => id === 'antigravity')).toMatchObject({
      id: 'antigravity',
      label: 'Google Antigravity',
      state: 'ready',
      application: 'detected',
      registration: 'missing',
    });
  });

  it('shows a replaceable legacy Codex registration for reviewed replacement', async () => {
    const binDirectory = join(root, 'codex bin');
    mkdirSync(binDirectory);
    const codexPath = join(binDirectory, 'codex');
    writeFileSync(codexPath, '#!/bin/sh\nexit 0\n');
    chmodSync(codexPath, 0o755);

    const calls: string[][] = [];
    const runCodexCommand = (_command: string, args: string[]) => {
      calls.push(args);
      return Promise.resolve({
        stdout:
          args[1] === 'list'
            ? JSON.stringify([
                {
                  name: 'nekosearch',
                  transport: {
                    type: 'stdio',
                    command: join(root, 'legacy nekosearch'),
                    args: ['serve'],
                  },
                },
              ])
            : '',
        stderr: '',
      });
    };
    const codexOptions = {
      homeDirectory,
      environment: { PATH: binDirectory },
      platform: 'linux' as NodeJS.Platform,
      serverCommand: command,
      runCodexCommand,
    };

    await expect(inspectSetupClients(codexOptions)).resolves.toEqual(
      expect.arrayContaining([
        {
          id: 'codex',
          label: 'Codex',
          state: 'conflict',
          application: 'detected',
          configuration: 'managed',
          registration: 'conflict',
          setupMode: 'automatic',
          scope: 'user',
          target: 'Codex user MCP registry (managed by `codex mcp`)',
          reason:
            'Codex already has a different MCP registration named nekosearch',
        },
      ]),
    );

    await expect(
      configureSetupClient('codex', {
        ...codexOptions,
        replaceConflictingCodex: true,
      }),
    ).resolves.toBe('added');
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'list', '--json'],
      ['mcp', 'remove', 'nekosearch'],
      ['mcp', 'add', 'nekosearch', '--', command.command, ...command.args],
    ]);
  });
});

function options(
  environment: NodeJS.ProcessEnv = {},
  commandExists: (command: string) => boolean = () => false,
) {
  return {
    homeDirectory,
    environment: { ...environment, PATH: '' },
    platform: 'linux' as NodeJS.Platform,
    serverCommand: command,
    commandExists,
  };
}

function parseJson(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, {
    allowTrailingComma: true,
  }) as Record<string, unknown>;
  if (errors.length > 0) {
    throw new Error('Test fixture contains invalid JSONC');
  }
  return parsed;
}

function readdirNames(directory: string): string[] {
  return readdirSync(directory).sort();
}
