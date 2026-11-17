import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  win32,
} from 'node:path';
import { homedir } from 'node:os';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import {
  configureCodexMcp,
  inspectCodexMcp,
  type CodexCommandRunner,
} from './codex-config.js';
import type { NekosearchStdioCommand } from './mcp-command.js';

export type SetupClientState =
  'already configured' | 'available' | 'not detected' | 'conflict';

export type SetupClientId =
  | 'codex'
  | 'claude-code'
  | 'cursor'
  | 'opencode'
  | 'grok-build'
  | 'github-copilot'
  | 'cline'
  | 'kiro'
  | 'zed'
  | 'junie'
  | 'antigravity'
  | 'claude-desktop';

export interface SetupClientStatus {
  id: SetupClientId;
  label: string;
  state: SetupClientState;
  automatic: boolean;
  reason?: string;
}

export interface SetupClientOptions {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  serverCommand: NekosearchStdioCommand;
  commandExists?: (command: string) => boolean;
  runCodexCommand?: CodexCommandRunner;
}

export type SetupClientConfigurationResult = 'added' | 'unchanged';

interface ClientDefinition {
  id: SetupClientId;
  label: string;
  automatic: boolean;
  inspect(options: ResolvedSetupClientOptions): Promise<SetupClientStatus>;
  configure?(
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientConfigurationResult>;
  instructions(options: ResolvedSetupClientOptions): string;
}

interface ResolvedSetupClientOptions extends SetupClientOptions {
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  commandExists: (command: string) => boolean;
}

interface JsonClientDefinition {
  id: SetupClientId;
  label: string;
  commands: string[];
  configPath(options: ResolvedSetupClientOptions): string;
  registrationPath: string[];
  createRegistration(command: NekosearchStdioCommand): Record<string, unknown>;
  matchesRegistration(
    registration: Record<string, unknown>,
    command: NekosearchStdioCommand,
  ): boolean;
  sample(options: ResolvedSetupClientOptions): string;
}

const JSON_CLIENTS: JsonClientDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    commands: ['claude'],
    configPath: ({ homeDirectory, environment }) =>
      join(environment.CLAUDE_CONFIG_DIR || homeDirectory, '.claude.json'),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      type: 'stdio',
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      (registration.type === undefined || registration.type === 'stdio') &&
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `User config: ${join(options.environment.CLAUDE_CONFIG_DIR || options.homeDirectory, '.claude.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { type: 'stdio', command: options.serverCommand.command, args: options.serverCommand.args })}\n` +
      'Claude Code also supports `claude mcp add --transport stdio --scope user nekosearch -- <node> <cli-entry-point> serve`.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    commands: ['cursor'],
    configPath: ({ homeDirectory }) =>
      join(homeDirectory, '.cursor', 'mcp.json'),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      type: 'stdio',
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      (registration.type === undefined || registration.type === 'stdio') &&
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `Global config: ${join(options.homeDirectory, '.cursor', 'mcp.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { type: 'stdio', command: options.serverCommand.command, args: options.serverCommand.args })}`,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    commands: ['opencode'],
    configPath: opencodeConfigPath,
    registrationPath: ['mcp', 'servers', 'nekosearch'],
    createRegistration: (command) => ({
      type: 'local',
      command: [command.command, ...command.args],
    }),
    matchesRegistration: (registration, command) =>
      registration.type === 'local' &&
      arraysEqual(registration.command, [command.command, ...command.args]),
    sample: (options) =>
      `Global config: ${join(options.environment.XDG_CONFIG_HOME || join(options.homeDirectory, '.config'), 'opencode', 'opencode.json(c)')}\n` +
      `Add this entry under mcp.servers:\n${jsonSnippet(['mcp', 'servers', 'nekosearch'], { type: 'local', command: [options.serverCommand.command, ...options.serverCommand.args] })}`,
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot CLI + VS Code Copilot Global',
    commands: ['copilot', 'code', 'code-insiders'],
    configPath: ({ homeDirectory, environment }) =>
      join(
        environment.COPILOT_HOME || join(homeDirectory, '.copilot'),
        'mcp-config.json',
      ),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      type: 'local',
      command: command.command,
      args: command.args,
      tools: ['*'],
    }),
    matchesRegistration: (registration, command) =>
      registration.type === 'local' &&
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `Shared Copilot user config: ${join(options.environment.COPILOT_HOME || join(options.homeDirectory, '.copilot'), 'mcp-config.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { type: 'local', command: options.serverCommand.command, args: options.serverCommand.args, tools: ['*'] })}\n` +
      'Copilot CLI and VS Code Copilot Global share this file.',
  },
  {
    id: 'cline',
    label: 'Cline',
    commands: ['cline'],
    configPath: ({ homeDirectory, environment }) =>
      environment.CLINE_MCP_SETTINGS_PATH ||
      join(
        homeDirectory,
        '.cline',
        'data',
        'settings',
        'cline_mcp_settings.json',
      ),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
      disabled: false,
      autoApprove: [],
    }),
    matchesRegistration: (registration, command) =>
      (registration.type === undefined || registration.type === 'stdio') &&
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `User config: ${options.environment.CLINE_MCP_SETTINGS_PATH || join(options.homeDirectory, '.cline', 'data', 'settings', 'cline_mcp_settings.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { command: options.serverCommand.command, args: options.serverCommand.args, disabled: false, autoApprove: [] })}`,
  },
  {
    id: 'kiro',
    label: 'Kiro',
    commands: ['kiro'],
    configPath: ({ homeDirectory }) =>
      join(homeDirectory, '.kiro', 'settings', 'mcp.json'),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `User config: ${join(options.homeDirectory, '.kiro', 'settings', 'mcp.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { command: options.serverCommand.command, args: options.serverCommand.args })}`,
  },
  {
    id: 'zed',
    label: 'Zed',
    commands: ['zed'],
    configPath: zedSettingsPath,
    registrationPath: ['context_servers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `User settings: ${zedSettingsPath(options)}\nAdd this entry under context_servers:\n${jsonSnippet(['context_servers', 'nekosearch'], { command: options.serverCommand.command, args: options.serverCommand.args })}`,
  },
  {
    id: 'junie',
    label: 'Junie',
    commands: ['junie'],
    configPath: ({ homeDirectory }) =>
      join(homeDirectory, '.junie', 'mcp', 'mcp.json'),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `User config: ${join(options.homeDirectory, '.junie', 'mcp', 'mcp.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { command: options.serverCommand.command, args: options.serverCommand.args })}`,
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    commands: ['agy'],
    configPath: ({ homeDirectory }) =>
      join(homeDirectory, '.gemini', 'config', 'mcp_config.json'),
    registrationPath: ['mcpServers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
    sample: (options) =>
      `Global config: ${join(options.homeDirectory, '.gemini', 'config', 'mcp_config.json')}\n` +
      `Add this entry under mcpServers:\n${jsonSnippet(['mcpServers', 'nekosearch'], { command: options.serverCommand.command, args: options.serverCommand.args })}`,
  },
];

const CLIENTS: ClientDefinition[] = [
  createCodexDefinition(),
  ...JSON_CLIENTS.map(createJsonClientDefinition),
  createGrokDefinition(),
  createClaudeDesktopDefinition(),
];

export async function inspectSetupClients(
  options: SetupClientOptions,
): Promise<SetupClientStatus[]> {
  const resolved = resolveOptions(options);
  return Promise.all(CLIENTS.map((client) => client.inspect(resolved)));
}

export async function configureSetupClient(
  id: SetupClientId,
  options: SetupClientOptions,
): Promise<SetupClientConfigurationResult> {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`Unknown MCP client ${id}`);
  if (!client.automatic || !client.configure) {
    throw new Error(`${client.label} does not support automatic setup`);
  }
  return client.configure(resolveOptions(options));
}

export function getManualSetupInstructions(
  id: SetupClientId,
  options: SetupClientOptions,
): string {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`Unknown MCP client ${id}`);
  return `${client.label}\n${client.instructions(resolveOptions(options))}`;
}

function createCodexDefinition(): ClientDefinition {
  const label = 'Codex';
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientStatus> => {
    const command = findExecutable('codex', options);
    if (!command) return status('codex', label, 'not detected', true);
    try {
      const inspection = await inspectCodexMcp({
        serverCommand: options.serverCommand,
        codexCommand: command,
        ...(options.runCodexCommand && { runCommand: options.runCodexCommand }),
      });
      return {
        id: 'codex',
        label,
        state: inspection.state,
        automatic: true,
        ...(inspection.state === 'conflict' && { reason: inspection.reason }),
      };
    } catch (error) {
      return status(
        'codex',
        label,
        'conflict',
        true,
        `Could not inspect the Codex registration safely: ${errorMessage(error)}`,
      );
    }
  };
  return {
    id: 'codex',
    label,
    automatic: true,
    inspect,
    async configure(options) {
      const command = findExecutable('codex', options);
      if (!command) throw new Error('Codex CLI was not detected on PATH');
      const result = await configureCodexMcp({
        serverCommand: options.serverCommand,
        codexCommand: command,
        ...(options.runCodexCommand && { runCommand: options.runCodexCommand }),
      });
      return result === 'unchanged' ? 'unchanged' : 'added';
    },
    instructions: (options) => {
      const arguments_ = [
        'mcp',
        'add',
        'nekosearch',
        '--',
        options.serverCommand.command,
        ...options.serverCommand.args,
      ];
      const quote =
        options.platform === 'win32'
          ? quotePowerShellArgument
          : quotePosixShellArgument;
      return `Use the Codex CLI: codex ${arguments_.map(quote).join(' ')}`;
    },
  };
}

function createJsonClientDefinition(
  definition: JsonClientDefinition,
): ClientDefinition {
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientStatus> => {
    let filePath: string;
    try {
      filePath = safeConfigPath(definition.configPath(options));
    } catch (error) {
      return status(
        definition.id,
        definition.label,
        'conflict',
        true,
        errorMessage(error),
      );
    }
    let fileExists: boolean;
    try {
      await lstat(filePath);
      fileExists = true;
    } catch (error) {
      if (!isMissingFile(error)) {
        return status(
          definition.id,
          definition.label,
          'conflict',
          true,
          `Cannot inspect ${filePath}: ${errorMessage(error)}`,
        );
      }
      fileExists = false;
    }
    if (
      !fileExists &&
      !definition.commands.some((name) => options.commandExists(name))
    ) {
      return status(definition.id, definition.label, 'not detected', true);
    }
    const inspected = await inspectJsonRegistration(
      filePath,
      definition.registrationPath,
      (registration, command) =>
        definition.matchesRegistration(registration, command),
      options.serverCommand,
    );
    return status(
      definition.id,
      definition.label,
      inspected.state,
      true,
      inspected.reason,
    );
  };
  return {
    id: definition.id,
    label: definition.label,
    automatic: true,
    inspect,
    configure: (options) =>
      installJsonRegistration(
        safeConfigPath(definition.configPath(options)),
        definition.registrationPath,
        definition.createRegistration(options.serverCommand),
        (registration, command) =>
          definition.matchesRegistration(registration, command),
        options.serverCommand,
      ),
    instructions: (options) => definition.sample(options),
  };
}

function createGrokDefinition(): ClientDefinition {
  const id = 'grok-build';
  const label = 'Grok Build CLI';
  const configPath = (options: ResolvedSetupClientOptions): string =>
    safeConfigPath(createGrokTomlPath(options));
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientStatus> => {
    let filePath: string;
    try {
      filePath = configPath(options);
    } catch (error) {
      return status(id, label, 'conflict', true, errorMessage(error));
    }
    let fileExists = false;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        return status(
          id,
          label,
          'conflict',
          true,
          `${filePath} is not a regular config file`,
        );
      }
      fileExists = true;
    } catch (error) {
      if (!isMissingFile(error)) {
        return status(
          id,
          label,
          'conflict',
          true,
          `Cannot inspect ${filePath}: ${errorMessage(error)}`,
        );
      }
    }
    if (!fileExists && !options.commandExists('grok'))
      return status(id, label, 'not detected', true);
    const inspected = await inspectTomlRegistration(
      filePath,
      options.serverCommand,
    );
    return status(id, label, inspected.state, true, inspected.reason);
  };
  return {
    id,
    label,
    automatic: true,
    inspect,
    configure: (options) =>
      installTomlRegistration(configPath(options), options.serverCommand),
    instructions: (options) =>
      `User config: ${configPath(options)}\nAdd [mcp_servers.nekosearch] with command = ${JSON.stringify(options.serverCommand.command)} and args = ${JSON.stringify(options.serverCommand.args)}. This adapter is for Grok Build CLI, not Grok in the browser.`,
  };
}

function createClaudeDesktopDefinition(): ClientDefinition {
  const id = 'claude-desktop';
  const label = 'Claude Desktop (manual only)';
  return {
    id,
    label,
    automatic: false,
    inspect(options) {
      const installed = claudeDesktopDetected(options);
      return Promise.resolve(
        status(
          id,
          label,
          installed ? 'available' : 'not detected',
          false,
          'Claude Desktop documents local setup through Desktop Extensions (DXT), not a supported raw stdio config path.',
        ),
      );
    },
    instructions: () =>
      'Claude Desktop currently installs local MCP servers through Desktop Extensions (DXT): Settings > Extensions > Advanced settings > Install Extension. NekoSearch does not include a DXT package; create or obtain one, then install it there. Claude Desktop is separate from Claude Code.',
  };
}

async function inspectJsonRegistration(
  filePath: string,
  registrationPath: string[],
  matches: JsonClientDefinition['matchesRegistration'],
  command: NekosearchStdioCommand,
): Promise<{ state: SetupClientState; reason?: string }> {
  const read = await readJsoncFile(filePath);
  if (read.state === 'missing') return { state: 'available' };
  if (read.state === 'conflict')
    return { state: 'conflict', reason: read.reason };
  const parent = getPath(read.value, registrationPath.slice(0, -1));
  if (parent !== undefined && !isRecord(parent)) {
    return {
      state: 'conflict',
      reason: `The ${registrationPath[0]} setting in ${filePath} is not an object`,
    };
  }
  const existing = getPath(read.value, registrationPath);
  if (existing === undefined) return { state: 'available' };
  if (isRecord(existing) && matches(existing, command)) {
    return { state: 'already configured' };
  }
  return {
    state: 'conflict',
    reason: `A different ${registrationPath.at(-1)} MCP entry already exists in ${filePath}; it was left unchanged`,
  };
}

async function installJsonRegistration(
  filePath: string,
  registrationPath: string[],
  registration: Record<string, unknown>,
  matches: JsonClientDefinition['matchesRegistration'],
  command: NekosearchStdioCommand,
): Promise<SetupClientConfigurationResult> {
  return withConfigLock(filePath, async () => {
    const current = await readJsoncFile(filePath);
    if (current.state === 'conflict') throw new Error(current.reason);
    const text = current.state === 'missing' ? '{}\n' : current.text;
    const value = current.state === 'missing' ? {} : current.value;
    const parent = getPath(value, registrationPath.slice(0, -1));
    if (parent !== undefined && !isRecord(parent)) {
      throw new Error(
        `The ${registrationPath[0]} setting in ${filePath} is not an object`,
      );
    }
    const existing = getPath(value, registrationPath);
    if (existing !== undefined) {
      if (isRecord(existing) && matches(existing, command)) return 'unchanged';
      throw new Error(
        `A different ${registrationPath.at(-1)} MCP entry already exists in ${filePath}; it was left unchanged`,
      );
    }

    const updated = applyEdits(
      text,
      modify(text, registrationPath, registration, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
    const errors: Parameters<typeof parseJsonc>[1] = [];
    const parsed: unknown = parseJsonc(updated, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 || !isRecord(parsed)) {
      throw new Error(
        `Could not safely edit ${filePath}: generated JSONC is invalid`,
      );
    }
    const added = getPath(parsed, registrationPath);
    if (!isRecord(added) || !matches(added, command)) {
      throw new Error(`Could not verify the NekoSearch entry in ${filePath}`);
    }
    await writeConfigFile(
      filePath,
      updated,
      current.state === 'missing' ? undefined : current.mode,
      current.state === 'missing' ? null : current.text,
    );
    return 'added';
  });
}

async function readJsoncFile(filePath: string): Promise<
  | { state: 'missing' }
  | { state: 'conflict'; reason: string }
  | {
      state: 'readable';
      text: string;
      value: Record<string, unknown>;
      mode: number;
    }
> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) return { state: 'missing' };
    return {
      state: 'conflict',
      reason: `Cannot inspect ${filePath}: ${errorMessage(error)}`,
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return {
      state: 'conflict',
      reason: `${filePath} is not a regular config file`,
    };
  }
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      state: 'conflict',
      reason: `Cannot read ${filePath}: ${errorMessage(error)}`,
    };
  }
  const errors: Parameters<typeof parseJsonc>[1] = [];
  const value: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    return {
      state: 'conflict',
      reason: `Cannot safely edit ${filePath}: ${first ? printParseErrorCode(first.error) : 'invalid JSONC'}`,
    };
  }
  if (!isRecord(value)) {
    return {
      state: 'conflict',
      reason: `Cannot safely edit ${filePath}: the root value is not an object`,
    };
  }
  return { state: 'readable', text, value, mode: info.mode & 0o777 };
}

async function inspectTomlRegistration(
  filePath: string,
  command: NekosearchStdioCommand,
): Promise<{ state: SetupClientState; reason?: string }> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return {
        state: 'conflict',
        reason: `${filePath} is not a regular config file`,
      };
    }
  } catch (error) {
    if (isMissingFile(error)) return { state: 'available' };
    return {
      state: 'conflict',
      reason: `Cannot inspect ${filePath}: ${errorMessage(error)}`,
    };
  }
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return { state: 'available' };
    return {
      state: 'conflict',
      reason: `Cannot read ${filePath}: ${errorMessage(error)}`,
    };
  }
  const parsed = parseSafeToml(text, filePath);
  if (parsed.state === 'conflict') return parsed;
  const parent = parsed.value.mcp_servers;
  if (parent !== undefined && !isRecord(parent)) {
    return {
      state: 'conflict',
      reason: `The mcp_servers setting in ${filePath} is not a table`,
    };
  }
  const existing = isRecord(parent) ? parent.nekosearch : undefined;
  if (existing === undefined) return { state: 'available' };
  return isRecord(existing) && tomlRegistrationMatches(existing, command)
    ? { state: 'already configured' }
    : {
        state: 'conflict',
        reason: `A different nekosearch MCP entry already exists in ${filePath}; it was left unchanged`,
      };
}

async function installTomlRegistration(
  filePath: string,
  command: NekosearchStdioCommand,
): Promise<SetupClientConfigurationResult> {
  return withConfigLock(filePath, async () => {
    let text: string;
    let originalText: string | null;
    let mode: number | undefined;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${filePath} is not a regular config file`);
      }
      mode = info.mode & 0o777;
      text = await readFile(filePath, 'utf8');
      originalText = text;
    } catch (error) {
      if (isMissingFile(error)) {
        text = '';
        originalText = null;
      } else throw error;
    }
    const parsed = parseSafeToml(text, filePath);
    if (parsed.state === 'conflict') throw new Error(parsed.reason);
    const parent = parsed.value.mcp_servers;
    if (parent !== undefined && !isRecord(parent)) {
      throw new Error(`The mcp_servers setting in ${filePath} is not a table`);
    }
    const existing = isRecord(parent) ? parent.nekosearch : undefined;
    if (existing !== undefined) {
      if (isRecord(existing) && tomlRegistrationMatches(existing, command))
        return 'unchanged';
      throw new Error(
        `A different nekosearch MCP entry already exists in ${filePath}; it was left unchanged`,
      );
    }
    const block = [
      '[mcp_servers.nekosearch]',
      `command = ${JSON.stringify(command.command)}`,
      `args = [${command.args.map((argument) => JSON.stringify(argument)).join(', ')}]`,
      '',
    ].join('\n');
    const updated = `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${text.trim().length > 0 ? '\n' : ''}${block}`;
    const verified = parseSafeToml(updated, filePath);
    const added = verified.state === 'readable' && verified.value.mcp_servers;
    if (
      !isRecord(added) ||
      !isRecord(added.nekosearch) ||
      !tomlRegistrationMatches(added.nekosearch, command)
    ) {
      throw new Error(`Could not verify the NekoSearch entry in ${filePath}`);
    }
    await writeConfigFile(filePath, updated, mode, originalText);
    return 'added';
  });
}

function parseSafeToml(
  text: string,
  filePath: string,
):
  | { state: 'readable'; value: Record<string, unknown> }
  | { state: 'conflict'; reason: string } {
  try {
    const value: unknown = parseToml(text, { unsafeKeyBehaviour: 'throw' });
    if (!isRecord(value)) throw new Error('the root value is not a table');
    return { state: 'readable', value };
  } catch (error) {
    return {
      state: 'conflict',
      reason: `Cannot safely edit ${filePath}: ${errorMessage(error)}`,
    };
  }
}

function tomlRegistrationMatches(
  registration: Record<string, unknown>,
  command: NekosearchStdioCommand,
): boolean {
  return (
    registration.command === command.command &&
    arraysEqual(registration.args, command.args)
  );
}

async function withConfigLock<T>(
  filePath: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.nekosearch-setup.lock`;
  let lock;
  const deadline = Date.now() + 5000;
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${lockPath}. Confirm no setup process is using this config, remove the lock file if it is abandoned, then retry.`,
          { cause: error },
        );
      }
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function writeConfigFile(
  filePath: string,
  content: string,
  previousMode: number | undefined,
  expectedCurrent: string | null,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(tempPath, 'wx', previousMode ?? 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await file.close();
  try {
    let current: string | null;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(
          `${filePath} changed to a non-regular file while setup was preparing the update`,
        );
      }
      current = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) current = null;
      else throw error;
    }
    if (current !== expectedCurrent) {
      throw new Error(
        `${filePath} changed while setup was preparing the update; no changes were written`,
      );
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw new Error(
      `Could not safely replace ${filePath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function resolveOptions(
  options: SetupClientOptions,
): ResolvedSetupClientOptions {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  return {
    ...options,
    homeDirectory,
    environment,
    platform,
    commandExists:
      options.commandExists ??
      ((command) =>
        findExecutable(command, { environment, platform }) !== undefined),
  };
}

function findExecutable(
  command: string,
  options: Pick<ResolvedSetupClientOptions, 'environment' | 'platform'>,
): string | undefined {
  const pathValue = options.environment.PATH ?? '';
  const extensions =
    options.platform === 'win32'
      ? (options.environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  const pathDelimiter = options.platform === 'win32' ? ';' : delimiter;
  for (const directory of pathValue.split(pathDelimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(
        directory,
        command.endsWith(extension) ? command : `${command}${extension}`,
      );
      try {
        if (options.platform === 'win32') {
          if (isRegularFileSync(candidate)) return candidate;
        } else {
          accessSync(candidate, constants.X_OK);
          if (isRegularFileSync(candidate)) return candidate;
        }
      } catch {
        // Continue searching PATH; setup never executes detected commands except Codex's CLI.
      }
    }
  }
  return undefined;
}

function zedSettingsPath(options: ResolvedSetupClientOptions): string {
  if (options.platform === 'win32') {
    return join(
      options.environment.APPDATA ||
        join(options.homeDirectory, 'AppData', 'Roaming'),
      'Zed',
      'settings.json',
    );
  }
  if (options.platform === 'darwin') {
    return join(
      options.homeDirectory,
      'Library',
      'Application Support',
      'Zed',
      'settings.json',
    );
  }
  return join(
    options.environment.XDG_CONFIG_HOME ||
      join(options.homeDirectory, '.config'),
    'zed',
    'settings.json',
  );
}

function claudeDesktopDetected(options: ResolvedSetupClientOptions): boolean {
  if (
    ['claude-desktop', 'Claude'].some((command) =>
      options.commandExists(command),
    )
  )
    return true;
  if (options.platform === 'darwin') {
    return (
      pathExists('/Applications/Claude.app') ||
      pathExists(join(options.homeDirectory, 'Applications', 'Claude.app'))
    );
  }
  if (options.platform === 'win32') {
    const localAppData = options.environment.LOCALAPPDATA;
    return Boolean(
      localAppData &&
      pathExists(join(localAppData, 'Programs', 'Claude', 'Claude.exe')),
    );
  }
  return (
    pathExists('/usr/bin/claude-desktop') || pathExists('/opt/Claude/claude')
  );
}

function createGrokTomlPath(options: ResolvedSetupClientOptions): string {
  return join(
    options.environment.GROK_HOME || join(options.homeDirectory, '.grok'),
    'config.toml',
  );
}

function opencodeConfigPath(options: ResolvedSetupClientOptions): string {
  const directory =
    options.environment.XDG_CONFIG_HOME ||
    join(options.homeDirectory, '.config');
  const jsonPath = join(directory, 'opencode', 'opencode.json');
  const jsoncPath = join(directory, 'opencode', 'opencode.jsonc');
  if (existsSync(jsonPath) && existsSync(jsoncPath)) {
    throw new Error(
      `Both ${jsonPath} and ${jsoncPath} exist; resolve the OpenCode config ambiguity before setup`,
    );
  }
  return existsSync(jsoncPath) ? jsoncPath : jsonPath;
}

function safeConfigPath(path: string): string {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new Error(`Refusing to edit a relative MCP config path: ${path}`);
  }
  return path;
}

function jsonSnippet(path: string[], value: Record<string, unknown>): string {
  const root: Record<string, unknown> = {};
  let current = root;
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      current[key] = value;
    } else {
      const child: Record<string, unknown> = {};
      current[key] = child;
      current = child;
    }
  }
  return JSON.stringify(root, null, 2);
}

function status(
  id: SetupClientId,
  label: string,
  state: SetupClientState,
  automatic: boolean,
  reason?: string,
): SetupClientStatus {
  return { id, label, state, automatic, ...(reason && { reason }) };
}

function getPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function arraysEqual(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every(
      (value, index) => typeof value === 'string' && value === right[index],
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isErrorCode(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, 'EEXIST');
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quotePosixShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function quotePowerShellArgument(argument: string): string {
  return `'${argument.replaceAll("'", "''")}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

// Sync helpers keep PATH detection side-effect free; they never launch a shell.
function isRegularFileSync(path: string): boolean {
  return statSync(path).isFile();
}
