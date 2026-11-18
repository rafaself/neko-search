import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import { arraysEqual, type NekosearchStdioCommand } from '../mcp-command.js';
import type { McpProviderRegistration } from './provider.types.js';

export const NEKOSEARCH_SERVER_NAME = 'nekosearch';

export const objectSchema = z.record(z.string(), z.unknown());
const stdioSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export function userRegistration(
  entry: Record<string, unknown>,
  origin: string,
  stdio: boolean,
  customized: boolean,
): McpProviderRegistration {
  const command = stdio ? stdioSchema.parse(entry) : undefined;
  return {
    name: NEKOSEARCH_SERVER_NAME,
    scope: 'user',
    origin,
    transport: command ? 'stdio' : 'other',
    ...command,
    customized,
  };
}

export function matchesUserRegistration(
  registration: McpProviderRegistration | undefined,
  server: NekosearchStdioCommand,
): boolean {
  return (
    registration?.scope === 'user' &&
    registration.transport === 'stdio' &&
    !registration.customized &&
    registration.command === server.command &&
    arraysEqual(registration.args ?? [], server.args)
  );
}

export function assertServerCommand(server: NekosearchStdioCommand): void {
  if (
    (!isAbsolute(server.command) && !win32.isAbsolute(server.command)) ||
    (!isAbsolute(server.args[0]) && !win32.isAbsolute(server.args[0])) ||
    server.args.length !== 2 ||
    server.args[1] !== 'serve'
  ) {
    throw new Error(
      'NekoSearch requires absolute Node and CLI paths for MCP setup',
    );
  }
}

export function isMissingFile(error: unknown): boolean {
  return z.object({ code: z.literal('ENOENT') }).safeParse(error).success;
}

export async function readUserJson(path: string): Promise<{
  source: string | undefined;
  data: Record<string, unknown>;
  mode: number;
}> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Expected a regular configuration file at ${path}`);
    }
    if (stat.size > 32 * 1024 * 1024) {
      throw new Error(`Configuration file exceeds the size limit at ${path}`);
    }
    const source = await readFile(path, 'utf8');
    try {
      return {
        source,
        data: objectSchema.parse(JSON.parse(source) as unknown),
        mode: stat.mode & 0o777,
      };
    } catch (cause) {
      throw new Error(`Cannot read configuration as a JSON object at ${path}`, {
        cause,
      });
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { source: undefined, data: {}, mode: 0o600 };
  }
}

export function userServerEntries(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return data.mcpServers === undefined
    ? {}
    : objectSchema.parse(data.mcpServers);
}

export function namedServer(
  entries: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return Object.hasOwn(entries, NEKOSEARCH_SERVER_NAME)
    ? objectSchema.parse(entries[NEKOSEARCH_SERVER_NAME])
    : undefined;
}
