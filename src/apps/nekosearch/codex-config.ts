import { execFile } from 'node:child_process';
import { isAbsolute, win32 } from 'node:path';
import { arraysEqual, type NekosearchStdioCommand } from './mcp-command.js';

const CODEX_MCP_NAME = 'nekosearch';
const CODEX_LIST_ARGS = ['mcp', 'list', '--json'];
const CODEX_TIMEOUT_MS = 30_000;
const CODEX_MAX_BUFFER_BYTES = 1024 * 1024;

interface CodexCommandResult {
  stdout: string;
  stderr: string;
}

export type CodexCommandRunner = (
  command: string,
  arguments_: string[],
) => Promise<CodexCommandResult>;

export interface ConfigureCodexMcpOptions {
  /** Absolute, shell-free command used to start this NekoSearch installation. */
  serverCommand: NekosearchStdioCommand;
  force?: boolean;
  codexCommand?: string;
  /** Injectable runner for deterministic command and conflict tests. */
  runCommand?: CodexCommandRunner;
}

export type ConfigureCodexMcpResult = 'added' | 'replaced' | 'unchanged';

export type CodexMcpInspection =
  | { state: 'available' }
  | { state: 'already configured' }
  | { state: 'conflict'; reason: string; replaceable: boolean };

export interface InspectCodexMcpOptions {
  serverCommand: NekosearchStdioCommand;
  codexCommand?: string;
  runCommand?: CodexCommandRunner;
}

/** Inspect Codex's user registration without changing it. */
export async function inspectCodexMcp(
  options: InspectCodexMcpOptions,
): Promise<CodexMcpInspection> {
  assertServerCommand(options.serverCommand);
  const codexCommand = options.codexCommand ?? 'codex';
  const runCommand = options.runCommand ?? executeCodexCommand;
  const registrations = await listCodexServers(codexCommand, runCommand);
  const matchingNames = registrations.filter(
    (registration) => registration.name === CODEX_MCP_NAME,
  );
  if (matchingNames.length > 1) {
    return {
      state: 'conflict',
      reason: `Codex returned multiple MCP registrations named ${CODEX_MCP_NAME}`,
      replaceable: false,
    };
  }
  const existing = matchingNames[0];
  if (!existing) return { state: 'available' };
  return registrationMatches(existing, options.serverCommand)
    ? { state: 'already configured' }
    : {
        state: 'conflict',
        reason: `Codex already has a different MCP registration named ${CODEX_MCP_NAME}`,
        replaceable: true,
      };
}

/** Register the current CLI with Codex using Codex's supported MCP commands. */
export async function configureCodexMcp(
  options: ConfigureCodexMcpOptions,
): Promise<ConfigureCodexMcpResult> {
  assertServerCommand(options.serverCommand);
  const codexCommand = options.codexCommand ?? 'codex';
  const runCommand = options.runCommand ?? executeCodexCommand;
  const inspection = await inspectCodexMcp({
    serverCommand: options.serverCommand,
    codexCommand,
    runCommand,
  });
  if (inspection.state === 'already configured') return 'unchanged';
  if (
    inspection.state === 'conflict' &&
    (!options.force || !inspection.replaceable)
  ) {
    throw new Error(`${inspection.reason}; pass --force to replace it`);
  }

  const replaced = inspection.state === 'conflict';
  if (replaced) {
    await runCodex(codexCommand, ['mcp', 'remove', CODEX_MCP_NAME], runCommand);
  }
  await runCodex(
    codexCommand,
    [
      'mcp',
      'add',
      CODEX_MCP_NAME,
      '--',
      options.serverCommand.command,
      ...options.serverCommand.args,
    ],
    runCommand,
  );
  return replaced ? 'replaced' : 'added';
}

async function listCodexServers(
  codexCommand: string,
  runCommand: CodexCommandRunner,
): Promise<CodexServerRegistration[]> {
  const { stdout } = await runCodex(codexCommand, CODEX_LIST_ARGS, runCommand);
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (cause) {
    throw new Error('Codex MCP list did not return valid JSON', { cause });
  }
  if (!Array.isArray(value) || !value.every(isCodexServerRegistration)) {
    throw new Error('Codex MCP list returned an unsupported JSON structure');
  }
  return value;
}

interface CodexServerRegistration {
  name: string;
  transport: {
    type: string;
    command?: string;
    args?: unknown;
  };
}

function isCodexServerRegistration(
  value: unknown,
): value is CodexServerRegistration {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isRecord(value.transport) &&
    typeof value.transport.type === 'string'
  );
}

function registrationMatches(
  registration: CodexServerRegistration,
  command: NekosearchStdioCommand,
): boolean {
  return (
    registration.transport.type === 'stdio' &&
    registration.transport.command === command.command &&
    Array.isArray(registration.transport.args) &&
    arraysEqual(registration.transport.args, command.args)
  );
}

function assertServerCommand(command: NekosearchStdioCommand): void {
  if (
    !isAbsolutePath(command.command) ||
    !isAbsolutePath(command.args[0]) ||
    command.args[1] !== 'serve'
  ) {
    throw new Error(
      'NekoSearch MCP command and CLI path must be absolute and end with serve',
    );
  }
}

async function runCodex(
  command: string,
  arguments_: string[],
  runCommand: CodexCommandRunner,
): Promise<CodexCommandResult> {
  try {
    return await runCommand(command, arguments_);
  } catch (error) {
    if (isMissingExecutable(error)) {
      throw new Error(
        'Codex CLI was not found. Install Codex CLI and ensure codex is available on PATH.',
        { cause: error },
      );
    }
    const detail = getCommandErrorDetail(error);
    throw new Error(
      `Codex command failed: codex ${arguments_.join(' ')}${detail ? `\n${detail}` : ''}`,
      { cause: error },
    );
  }
}

function executeCodexCommand(
  command: string,
  arguments_: string[],
): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      arguments_,
      {
        encoding: 'utf8',
        maxBuffer: CODEX_MAX_BUFFER_BYTES,
        shell: false,
        timeout: CODEX_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandError = new Error(error.message, { cause: error });
          Object.assign(commandError, error, { stdout, stderr });
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function isMissingExecutable(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function getCommandErrorDetail(error: unknown): string {
  if (!isRecord(error)) return '';
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) return stderr;
  return error instanceof Error ? error.message : '';
}
