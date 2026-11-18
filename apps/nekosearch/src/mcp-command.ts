import { isAbsolute, resolve, win32 } from 'node:path';

/** A shell-free launch command shared by every supported MCP client. */
export interface NekosearchStdioCommand {
  command: string;
  args: [string, 'serve'];
}

export function createNekosearchStdioCommand(
  cliEntryPoint: string,
  nodeExecutable = process.execPath,
): NekosearchStdioCommand {
  const command = resolve(nodeExecutable);
  const cliPath = resolve(cliEntryPoint);
  if (!isAbsolutePath(command) || !isAbsolutePath(cliPath)) {
    throw new Error('NekoSearch MCP command paths must be absolute');
  }
  return { command, args: [cliPath, 'serve'] };
}

export function registrationMatchesCommand(
  registration: unknown,
  command: NekosearchStdioCommand,
  options: { type?: string; commandIsArray?: boolean } = {},
): boolean {
  if (!isRecord(registration)) return false;
  if (options.type && registration.type !== options.type) return false;

  const expectedCommand = options.commandIsArray
    ? [command.command, ...command.args]
    : command.command;
  const actualCommand = registration.command;
  if (Array.isArray(expectedCommand)) {
    return (
      Array.isArray(actualCommand) &&
      arraysEqual(actualCommand, expectedCommand)
    );
  }
  return (
    actualCommand === expectedCommand &&
    Array.isArray(registration.args) &&
    arraysEqual(registration.args, command.args)
  );
}

export function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}
