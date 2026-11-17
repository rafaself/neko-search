import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
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
  removeCodexMcp,
  type CodexCommandRunner,
} from './codex-config.js';
import type { NekosearchStdioCommand } from './mcp-command.js';

type SetupClientAvailability =
  'already configured' | 'available' | 'not detected' | 'conflict';

export type SetupClientState =
  'ready' | 'already-configured' | 'conflict' | 'not-detected' | 'manual-only';

export type SetupClientApplicationState =
  'detected' | 'not-detected' | 'manual-only';

export type SetupClientConfigurationState =
  'available' | 'missing' | 'unsafe' | 'unreadable' | 'managed' | 'unknown';

export type SetupClientRegistrationState =
  'missing' | 'configured' | 'conflict' | 'unknown';

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
  | 'antigravity';

export interface SetupClientStatus {
  id: SetupClientId;
  label: string;
  state: SetupClientState;
  application: SetupClientApplicationState;
  configuration: SetupClientConfigurationState;
  registration: SetupClientRegistrationState;
  setupMode: 'automatic' | 'manual';
  scope: 'user' | 'project';
  target: string;
  reason?: string;
  replaceable?: boolean;
}

type SetupClientInspection = SetupClientStatus;

export interface SetupClientOptions {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  serverCommand: NekosearchStdioCommand;
  commandExists?: (command: string) => boolean;
  applicationPathExists?: (path: string) => boolean;
  runCodexCommand?: CodexCommandRunner;
  replaceConflictingCodex?: boolean;
  removeConflictingCodex?: boolean;
}

export type SetupClientConfigurationResult = 'added' | 'unchanged';
export type SetupClientRemovalResult = 'removed' | 'unchanged';

interface ClientDefinition {
  id: SetupClientId;
  label: string;
  inspect(options: ResolvedSetupClientOptions): Promise<SetupClientInspection>;
  configure?(
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientConfigurationResult>;
  remove?(
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientRemovalResult>;
}

interface ResolvedSetupClientOptions extends SetupClientOptions {
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  commandExists: (command: string) => boolean;
  applicationPathExists: (path: string) => boolean;
}

interface JsonClientDefinition {
  id: SetupClientId;
  label: string;
  commands: string[];
  application?: DesktopApplication;
  detectApplication?: (options: ResolvedSetupClientOptions) => boolean;
  manualOnly?: boolean;
  configPath(options: ResolvedSetupClientOptions): string;
  registrationPath: string[];
  createRegistration(command: NekosearchStdioCommand): Record<string, unknown>;
  matchesRegistration(
    registration: Record<string, unknown>,
    command: NekosearchStdioCommand,
  ): boolean;
}

interface DesktopApplication {
  product: string;
  executable: string;
  windowsDirectory?: string;
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
  },
  {
    id: 'cursor',
    label: 'Cursor',
    commands: ['cursor'],
    application: { product: 'Cursor', executable: 'Cursor' },
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
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot CLI + VS Code Copilot Global',
    commands: ['copilot'],
    detectApplication: (options) =>
      isVsCodeInstalled(options) &&
      hasVsCodeExtension('github.copilot', options),
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
  },
  {
    id: 'cline',
    label: 'Cline',
    commands: [],
    detectApplication: (options) =>
      isVsCodeInstalled(options) &&
      hasVsCodeExtension('saoudrizwan.claude-dev', options),
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
  },
  {
    id: 'kiro',
    label: 'Kiro',
    commands: ['kiro'],
    application: { product: 'Kiro', executable: 'Kiro' },
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
  },
  {
    id: 'zed',
    label: 'Zed',
    commands: ['zed'],
    application: { product: 'Zed', executable: 'zed' },
    configPath: zedSettingsPath,
    registrationPath: ['context_servers', 'nekosearch'],
    createRegistration: (command) => ({
      command: command.command,
      args: command.args,
    }),
    matchesRegistration: (registration, command) =>
      registration.command === command.command &&
      arraysEqual(registration.args, command.args),
  },
  {
    id: 'junie',
    label: 'Junie',
    commands: [],
    manualOnly: true,
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
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    commands: ['agy'],
    application: { product: 'Antigravity', executable: 'antigravity' },
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
  },
];

const CLIENTS: ClientDefinition[] = [
  createCodexDefinition(),
  ...JSON_CLIENTS.map(createJsonClientDefinition),
  createGrokDefinition(),
];

export async function inspectSetupClients(
  options: SetupClientOptions,
): Promise<SetupClientStatus[]> {
  const resolved = resolveOptions(options);
  const inspections = await Promise.all(
    CLIENTS.map((client) => client.inspect(resolved)),
  );
  return inspections.map((client) => {
    const publicStatus: SetupClientStatus = {
      id: client.id,
      label: client.label,
      state: client.state,
      application: client.application,
      configuration: client.configuration,
      registration: client.registration,
      setupMode: client.setupMode,
      scope: client.scope,
      target: client.target,
      ...(client.reason && { reason: client.reason }),
      ...(client.replaceable && { replaceable: true }),
    };
    return publicStatus;
  });
}

export async function configureSetupClient(
  id: SetupClientId,
  options: SetupClientOptions,
): Promise<SetupClientConfigurationResult> {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`Unknown MCP client ${id}`);
  if (!client.configure)
    throw new Error(`${client.label} cannot be configured`);
  return client.configure(resolveOptions(options));
}

export async function removeSetupClient(
  id: SetupClientId,
  options: SetupClientOptions,
): Promise<SetupClientRemovalResult> {
  const client = CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`Unknown MCP client ${id}`);
  if (!client.remove) throw new Error(`${client.label} cannot be unconfigured`);
  return client.remove(resolveOptions(options));
}

function createCodexDefinition(): ClientDefinition {
  const label = 'Codex';
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientInspection> => {
    const command = findExecutable('codex', options);
    const target = join(options.homeDirectory, '.codex', 'config.toml');
    if (!command) {
      return isDesktopApplicationInstalled(
        { product: 'Codex', executable: 'Codex' },
        options,
      )
        ? {
            id: 'codex',
            label,
            state: 'manual-only',
            application: 'detected',
            configuration: 'managed',
            registration: 'unknown',
            setupMode: 'manual',
            scope: 'user',
            target,
          }
        : {
            id: 'codex',
            label,
            state: 'not-detected',
            application: 'not-detected',
            configuration: 'unknown',
            registration: 'unknown',
            setupMode: 'automatic',
            scope: 'user',
            target,
          };
    }
    const codexHome = codexHomeDirectory(options);
    if (!existsSync(codexHome)) {
      return {
        id: 'codex',
        label,
        state: 'ready',
        application: 'detected',
        configuration: 'managed',
        registration: 'missing',
        setupMode: 'automatic',
        scope: 'user',
        target: 'Codex user MCP registry (managed by `codex mcp`)',
      };
    }
    try {
      const inspection = await inspectCodexMcp({
        serverCommand: options.serverCommand,
        codexCommand: command,
        ...(options.runCodexCommand && { runCommand: options.runCodexCommand }),
      });
      const replaceable =
        inspection.state === 'conflict' && inspection.replaceable;
      return {
        id: 'codex',
        label,
        state: replaceable
          ? 'already-configured'
          : setupClientState(inspection.state),
        application: 'detected',
        configuration: 'managed',
        registration: replaceable
          ? 'configured'
          : registrationState(inspection.state),
        setupMode: 'automatic',
        scope: 'user',
        target: 'Codex user MCP registry (managed by `codex mcp`)',
        ...(replaceable && { replaceable: true }),
        ...(inspection.state === 'conflict' && { reason: inspection.reason }),
      };
    } catch (error) {
      return status(
        'codex',
        label,
        'conflict',
        `Could not inspect the Codex registration safely: ${errorMessage(error)}`,
        {
          application: 'detected',
          configuration: 'managed',
          registration: 'unknown',
          setupMode: 'automatic',
          scope: 'user',
          target: 'Codex user MCP registry (managed by `codex mcp`)',
        },
      );
    }
  };
  return {
    id: 'codex',
    label,
    inspect,
    async configure(options) {
      const command = findExecutable('codex', options);
      if (!command) throw new Error('Codex CLI was not detected on PATH');
      await mkdir(codexHomeDirectory(options), { recursive: true });
      const result = await configureCodexMcp({
        serverCommand: options.serverCommand,
        codexCommand: command,
        force: options.replaceConflictingCodex,
        ...(options.runCodexCommand && { runCommand: options.runCodexCommand }),
      });
      return result === 'unchanged' ? 'unchanged' : 'added';
    },
    async remove(options) {
      const command = findExecutable('codex', options);
      if (!command) throw new Error('Codex CLI was not detected on PATH');
      return removeCodexMcp({
        serverCommand: options.serverCommand,
        force: options.removeConflictingCodex,
        codexCommand: command,
        ...(options.runCodexCommand && { runCommand: options.runCodexCommand }),
      });
    },
  };
}

function codexHomeDirectory(
  options: Pick<ResolvedSetupClientOptions, 'environment' | 'homeDirectory'>,
): string {
  const configured = options.environment.CODEX_HOME?.trim();
  return resolve(configured || join(options.homeDirectory, '.codex'));
}

function createJsonClientDefinition(
  definition: JsonClientDefinition,
): ClientDefinition {
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientInspection> => {
    if (definition.manualOnly) {
      let target = 'Client MCP settings';
      try {
        target = safeConfigPath(definition.configPath(options));
      } catch {
        // The generic manual target remains useful when app config paths conflict.
      }
      return {
        id: definition.id,
        label: definition.label,
        state: 'manual-only',
        application: 'manual-only',
        configuration: 'unknown',
        registration: 'unknown',
        setupMode: 'manual',
        scope: 'user',
        target,
      };
    }
    const applicationDetected =
      definition.commands.some((name) => options.commandExists(name)) ||
      (definition.application !== undefined &&
        isDesktopApplicationInstalled(definition.application, options)) ||
      definition.detectApplication?.(options) === true;
    let filePath: string;
    try {
      filePath = safeConfigPath(definition.configPath(options));
    } catch (error) {
      return status(
        definition.id,
        definition.label,
        applicationDetected ? 'conflict' : 'not detected',
        errorMessage(error),
        {
          application: applicationDetected ? 'detected' : 'not-detected',
          configuration: 'unsafe',
          registration: 'unknown',
          setupMode: 'automatic',
          scope: 'user',
          target: `${definition.label} user configuration`,
        },
      );
    }
    const inspected = await inspectJsonRegistration(
      filePath,
      definition.registrationPath,
      (registration, command) =>
        definition.matchesRegistration(registration, command),
      options.serverCommand,
    );
    return {
      id: definition.id,
      label: definition.label,
      state: detectedClientState(applicationDetected, inspected.state),
      application: applicationDetected ? 'detected' : 'not-detected',
      configuration: inspected.configuration,
      registration: inspected.registration,
      setupMode: 'automatic',
      scope: 'user',
      target: filePath,
      ...(inspected.reason && { reason: inspected.reason }),
    };
  };
  return {
    id: definition.id,
    label: definition.label,
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
    remove: (options) =>
      removeJsonRegistration(
        safeConfigPath(definition.configPath(options)),
        definition.registrationPath,
        (registration, command) =>
          definition.matchesRegistration(registration, command),
        options.serverCommand,
      ),
  };
}

function createGrokDefinition(): ClientDefinition {
  const id = 'grok-build';
  const label = 'Grok Build CLI';
  const configPath = (options: ResolvedSetupClientOptions): string =>
    safeConfigPath(createGrokTomlPath(options));
  const inspect = async (
    options: ResolvedSetupClientOptions,
  ): Promise<SetupClientInspection> => {
    const applicationDetected = options.commandExists('grok');
    let filePath: string;
    try {
      filePath = configPath(options);
    } catch (error) {
      return status(
        id,
        label,
        applicationDetected ? 'conflict' : 'not detected',
        errorMessage(error),
        {
          application: applicationDetected ? 'detected' : 'not-detected',
          configuration: 'unsafe',
          registration: 'unknown',
          setupMode: 'automatic',
          scope: 'user',
          target: 'Grok Build user configuration',
        },
      );
    }
    const inspected = await inspectTomlRegistration(
      filePath,
      options.serverCommand,
    );
    return {
      id,
      label,
      state: detectedClientState(applicationDetected, inspected.state),
      application: applicationDetected ? 'detected' : 'not-detected',
      configuration: inspected.configuration,
      registration: inspected.registration,
      setupMode: 'automatic',
      scope: 'user',
      target: filePath,
      ...(inspected.reason && { reason: inspected.reason }),
    };
  };
  return {
    id,
    label,
    inspect,
    configure: (options) =>
      installTomlRegistration(configPath(options), options.serverCommand),
    remove: (options) =>
      removeTomlRegistration(configPath(options), options.serverCommand),
  };
}

function detectedClientState(
  applicationDetected: boolean,
  registrationState: SetupClientAvailability,
): SetupClientState {
  if (registrationState === 'already configured') return 'already-configured';
  if (registrationState === 'conflict') return 'conflict';
  return applicationDetected ? 'ready' : 'not-detected';
}

async function inspectJsonRegistration(
  filePath: string,
  registrationPath: string[],
  matches: JsonClientDefinition['matchesRegistration'],
  command: NekosearchStdioCommand,
): Promise<{
  state: SetupClientAvailability;
  configuration: SetupClientConfigurationState;
  registration: SetupClientRegistrationState;
  reason?: string;
}> {
  const read = await readJsoncFile(filePath);
  if (read.state === 'missing') {
    return {
      state: 'available',
      configuration: 'missing',
      registration: 'missing',
    };
  }
  if (read.state === 'conflict')
    return {
      state: 'conflict',
      configuration: read.configuration,
      registration: 'unknown',
      reason: read.reason,
    };
  const parent = getPath(read.value, registrationPath.slice(0, -1));
  if (parent !== undefined && !isRecord(parent)) {
    return {
      state: 'conflict',
      configuration: 'available',
      registration: 'conflict',
      reason: `The ${registrationPath[0]} setting in ${filePath} is not an object`,
    };
  }
  const existing = getPath(read.value, registrationPath);
  if (existing === undefined) {
    return {
      state: 'available',
      configuration: 'available',
      registration: 'missing',
    };
  }
  if (isRecord(existing) && matches(existing, command)) {
    return {
      state: 'already configured',
      configuration: 'available',
      registration: 'configured',
    };
  }
  return {
    state: 'conflict',
    configuration: 'available',
    registration: 'conflict',
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

async function removeJsonRegistration(
  filePath: string,
  registrationPath: string[],
  matches: JsonClientDefinition['matchesRegistration'],
  command: NekosearchStdioCommand,
): Promise<SetupClientRemovalResult> {
  return withConfigLock(filePath, async () => {
    const current = await readJsoncFile(filePath);
    if (current.state === 'missing') return 'unchanged';
    if (current.state === 'conflict') throw new Error(current.reason);
    const parent = getPath(current.value, registrationPath.slice(0, -1));
    if (parent !== undefined && !isRecord(parent)) {
      throw new Error(
        `The ${registrationPath[0]} setting in ${filePath} is not an object`,
      );
    }
    const existing = getPath(current.value, registrationPath);
    if (existing === undefined) return 'unchanged';
    if (!isRecord(existing) || !matches(existing, command)) {
      throw new Error(
        `The ${registrationPath.at(-1)} MCP entry in ${filePath} no longer matches this NekoSearch setup; it was left unchanged`,
      );
    }

    const updated = applyEdits(
      current.text,
      modify(current.text, registrationPath, undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
    const errors: Parameters<typeof parseJsonc>[1] = [];
    const parsed: unknown = parseJsonc(updated, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (
      errors.length > 0 ||
      !isRecord(parsed) ||
      getPath(parsed, registrationPath) !== undefined
    ) {
      throw new Error(
        `Could not safely remove the NekoSearch entry from ${filePath}`,
      );
    }
    await writeConfigFile(filePath, updated, current.mode, current.text);
    return 'removed';
  });
}

async function readJsoncFile(filePath: string): Promise<
  | { state: 'missing'; configuration: 'missing' }
  | {
      state: 'conflict';
      configuration: 'unsafe' | 'unreadable';
      reason: string;
    }
  | {
      state: 'readable';
      configuration: 'available';
      text: string;
      value: Record<string, unknown>;
      mode: number;
    }
> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return { state: 'missing', configuration: 'missing' };
    }
    return {
      state: 'conflict',
      configuration: 'unreadable',
      reason: `Cannot inspect ${filePath}: ${errorMessage(error)}`,
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return {
      state: 'conflict',
      configuration: 'unsafe',
      reason: `${filePath} is not a regular config file`,
    };
  }
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      state: 'conflict',
      configuration: 'unreadable',
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
      configuration: 'unsafe',
      reason: `Cannot safely edit ${filePath}: ${first ? printParseErrorCode(first.error) : 'invalid JSONC'}`,
    };
  }
  if (!isRecord(value)) {
    return {
      state: 'conflict',
      configuration: 'unsafe',
      reason: `Cannot safely edit ${filePath}: the root value is not an object`,
    };
  }
  return {
    state: 'readable',
    configuration: 'available',
    text,
    value,
    mode: info.mode & 0o777,
  };
}

async function inspectTomlRegistration(
  filePath: string,
  command: NekosearchStdioCommand,
): Promise<{
  state: SetupClientAvailability;
  configuration: SetupClientConfigurationState;
  registration: SetupClientRegistrationState;
  reason?: string;
}> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return {
        state: 'conflict',
        configuration: 'unsafe',
        registration: 'unknown',
        reason: `${filePath} is not a regular config file`,
      };
    }
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        state: 'available',
        configuration: 'missing',
        registration: 'missing',
      };
    }
    return {
      state: 'conflict',
      configuration: 'unreadable',
      registration: 'unknown',
      reason: `Cannot inspect ${filePath}: ${errorMessage(error)}`,
    };
  }
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        state: 'available',
        configuration: 'missing',
        registration: 'missing',
      };
    }
    return {
      state: 'conflict',
      configuration: 'unreadable',
      registration: 'unknown',
      reason: `Cannot read ${filePath}: ${errorMessage(error)}`,
    };
  }
  const parsed = parseSafeToml(text, filePath);
  if (parsed.state === 'conflict') {
    return {
      ...parsed,
      configuration: 'unsafe',
      registration: 'unknown',
    };
  }
  const parent = parsed.value.mcp_servers;
  if (parent !== undefined && !isRecord(parent)) {
    return {
      state: 'conflict',
      configuration: 'available',
      registration: 'conflict',
      reason: `The mcp_servers setting in ${filePath} is not a table`,
    };
  }
  const existing = isRecord(parent) ? parent.nekosearch : undefined;
  if (existing === undefined) {
    return {
      state: 'available',
      configuration: 'available',
      registration: 'missing',
    };
  }
  return isRecord(existing) && tomlRegistrationMatches(existing, command)
    ? {
        state: 'already configured',
        configuration: 'available',
        registration: 'configured',
      }
    : {
        state: 'conflict',
        configuration: 'available',
        registration: 'conflict',
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

async function removeTomlRegistration(
  filePath: string,
  command: NekosearchStdioCommand,
): Promise<SetupClientRemovalResult> {
  return withConfigLock(filePath, async () => {
    let text: string;
    let mode: number;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${filePath} is not a regular config file`);
      }
      mode = info.mode & 0o777;
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return 'unchanged';
      throw error;
    }
    const parsed = parseSafeToml(text, filePath);
    if (parsed.state === 'conflict') throw new Error(parsed.reason);
    const parent = parsed.value.mcp_servers;
    if (parent !== undefined && !isRecord(parent)) {
      throw new Error(`The mcp_servers setting in ${filePath} is not a table`);
    }
    const existing = isRecord(parent) ? parent.nekosearch : undefined;
    if (existing === undefined) return 'unchanged';
    if (!isRecord(existing) || !tomlRegistrationMatches(existing, command)) {
      throw new Error(
        `The nekosearch MCP entry in ${filePath} no longer matches this NekoSearch setup; it was left unchanged`,
      );
    }

    const updated = removeTomlRegistrationSections(text, filePath);
    const verified = parseSafeToml(updated, filePath);
    if (verified.state === 'conflict') throw new Error(verified.reason);
    const remainingParent = verified.value.mcp_servers;
    if (
      remainingParent !== undefined &&
      (!isRecord(remainingParent) || remainingParent.nekosearch !== undefined)
    ) {
      throw new Error(
        `Could not verify removal of the NekoSearch entry in ${filePath}`,
      );
    }
    await writeConfigFile(filePath, updated, mode, text);
    return 'removed';
  });
}

function removeTomlRegistrationSections(
  text: string,
  filePath: string,
): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const headerPattern = /^\s*(\[\[?)\s*(.*?)\s*(\]\]?)\s*(?:#.*)?(?:\r?\n)?$/u;
  let insideNekoSearch = false;
  let foundNekoSearch = false;
  const remaining: string[] = [];

  for (const line of lines) {
    const header = line.match(headerPattern);
    if (header) {
      const path = header[2]?.replace(/[\s"']/gu, '') ?? '';
      insideNekoSearch =
        header[1] === '[' &&
        (path === 'mcp_servers.nekosearch' ||
          path.startsWith('mcp_servers.nekosearch.'));
      foundNekoSearch ||= insideNekoSearch;
    }
    if (!insideNekoSearch) remaining.push(line);
  }

  if (!foundNekoSearch) {
    throw new Error(
      `The NekoSearch entry in ${filePath} is not in a removable TOML table; it was left unchanged`,
    );
  }
  return remaining.join('');
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
    applicationPathExists:
      options.applicationPathExists ??
      ((path) => isExecutableApplicationPath(path, platform)),
  };
}

function isDesktopApplicationInstalled(
  application: DesktopApplication,
  options: ResolvedSetupClientOptions,
): boolean {
  return desktopApplicationPaths(application, options).some((path) =>
    options.applicationPathExists(path),
  );
}

function desktopApplicationPaths(
  application: DesktopApplication,
  options: Pick<
    ResolvedSetupClientOptions,
    'homeDirectory' | 'environment' | 'platform'
  >,
): string[] {
  const { product, executable } = application;
  if (options.platform === 'darwin') {
    return [
      join('/Applications', `${product}.app`, 'Contents', 'MacOS', executable),
      join(
        options.homeDirectory,
        'Applications',
        `${product}.app`,
        'Contents',
        'MacOS',
        executable,
      ),
    ];
  }
  if (options.platform === 'win32') {
    const programName = application.windowsDirectory ?? product;
    const binary = `${executable}.exe`;
    const localPrograms = join(
      options.environment.LOCALAPPDATA ||
        join(options.homeDirectory, 'AppData', 'Local'),
      'Programs',
      programName,
      binary,
    );
    return [
      localPrograms,
      ...(options.environment.ProgramFiles
        ? [join(options.environment.ProgramFiles, programName, binary)]
        : []),
      ...(options.environment['ProgramFiles(x86)']
        ? [join(options.environment['ProgramFiles(x86)'], programName, binary)]
        : []),
    ];
  }
  return [
    `/usr/bin/${executable}`,
    `/usr/local/bin/${executable}`,
    `/opt/${product}/${executable}`,
    join(options.homeDirectory, '.local', 'bin', executable),
  ];
}

function isVsCodeInstalled(options: ResolvedSetupClientOptions): boolean {
  return (
    options.commandExists('code') ||
    options.commandExists('code-insiders') ||
    isDesktopApplicationInstalled(
      {
        product: 'Visual Studio Code',
        executable: 'Code',
        windowsDirectory: 'Microsoft VS Code',
      },
      options,
    )
  );
}

function hasVsCodeExtension(
  extensionId: string,
  options: ResolvedSetupClientOptions,
): boolean {
  const roots = [
    join(options.homeDirectory, '.vscode', 'extensions'),
    join(options.homeDirectory, '.vscode-insiders', 'extensions'),
    join(options.homeDirectory, '.vscode-oss', 'extensions'),
  ];
  const prefix = extensionId.toLowerCase();
  return roots.some((directory) => {
    try {
      return readdirSync(directory).some((entry) => {
        const candidate = entry.toLowerCase();
        return candidate === prefix || candidate.startsWith(`${prefix}-`);
      });
    } catch {
      return false;
    }
  });
}

function isExecutableApplicationPath(
  path: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

function status(
  id: SetupClientId,
  label: string,
  state: SetupClientAvailability,
  reason?: string,
  details?: Partial<
    Pick<
      SetupClientStatus,
      | 'application'
      | 'configuration'
      | 'registration'
      | 'setupMode'
      | 'scope'
      | 'target'
    >
  >,
): SetupClientInspection {
  return {
    id,
    label,
    state: setupClientState(state),
    application:
      details?.application ??
      (state === 'not detected' ? 'not-detected' : 'detected'),
    configuration: details?.configuration ?? 'unknown',
    registration: details?.registration ?? registrationState(state),
    setupMode: details?.setupMode ?? 'automatic',
    scope: details?.scope ?? 'user',
    target: details?.target ?? `${label} user configuration`,
    ...(reason && { reason }),
  };
}

function setupClientState(state: SetupClientAvailability): SetupClientState {
  switch (state) {
    case 'available':
      return 'ready';
    case 'already configured':
      return 'already-configured';
    case 'conflict':
      return 'conflict';
    case 'not detected':
      return 'not-detected';
  }
}

function registrationState(
  state: SetupClientAvailability,
): SetupClientRegistrationState {
  switch (state) {
    case 'available':
      return 'missing';
    case 'already configured':
      return 'configured';
    case 'conflict':
      return 'conflict';
    case 'not detected':
      return 'unknown';
  }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// Sync helpers keep PATH detection side-effect free; they never launch a shell.
function isRegularFileSync(path: string): boolean {
  return statSync(path).isFile();
}
