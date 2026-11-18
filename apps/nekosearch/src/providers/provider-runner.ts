import { spawn } from 'node:child_process';
import { constants, accessSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ProviderCommandResult {
  stdout: string;
  stderr: string;
}

export interface ProviderCommandOptions {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProviderCommandRunner {
  resolve(
    executable: string,
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ): string | undefined;
  run(
    executable: string,
    arguments_: string[],
    options: ProviderCommandOptions,
  ): Promise<ProviderCommandResult>;
}

export const providerCommandRunner: ProviderCommandRunner = {
  resolve: resolveProviderExecutable,
  run: runProviderCommand,
};

export function resolveProviderExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (isAbsolute(executable)) {
    return isExecutableFile(executable, platform)
      ? resolve(executable)
      : undefined;
  }

  const pathValue = environment.PATH ?? '';
  const pathSeparator = platform === 'win32' ? ';' : delimiter;
  const extensions =
    platform === 'win32'
      ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];
  const hasExtension = extname(executable) !== '';

  for (const directory of pathValue.split(pathSeparator)) {
    if (!directory) continue;
    for (const extension of hasExtension ? [''] : extensions) {
      const candidate = resolve(directory, `${executable}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function runProviderCommand(
  executable: string,
  arguments_: string[],
  options: ProviderCommandOptions,
): Promise<ProviderCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const environment = {
    ...options.environment,
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const launch = createLaunch(
    executable,
    arguments_,
    options.platform,
    environment,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.executable, launch.arguments, {
      cwd: options.cwd ?? tmpdir(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(launch.windowsVerbatimArguments && {
        windowsVerbatimArguments: true,
      }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const finish = (error?: Error, result?: ProviderCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error);
      else resolvePromise(result ?? { stdout: '', stderr: '' });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timeout.unref?.();

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(
          new Error(`Provider CLI output exceeded ${maxOutputBytes} bytes`),
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) => {
      finish(
        new Error(`Could not run provider CLI: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`Provider CLI timed out after ${timeoutMs} ms`));
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0) {
        const exit =
          code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
        const detail = result.stderr.trim();
        finish(
          new Error(
            `Provider CLI failed with ${exit}${detail ? `: ${detail}` : ''}`,
          ),
        );
        return;
      }
      finish(undefined, result);
    });
  });
}

interface LaunchCommand {
  executable: string;
  arguments: string[];
  windowsVerbatimArguments?: boolean;
}

function createLaunch(
  executable: string,
  arguments_: string[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): LaunchCommand {
  if (
    platform !== 'win32' ||
    !['.cmd', '.bat'].includes(extname(executable).toLowerCase())
  ) {
    return { executable, arguments: arguments_ };
  }

  const commandProcessor =
    environment.ComSpec ??
    join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return {
    executable: commandProcessor,
    arguments: [
      '/d',
      '/s',
      '/c',
      buildWindowsCommandLine(executable, arguments_),
    ],
    windowsVerbatimArguments: true,
  };
}

export function buildWindowsCommandLine(
  executable: string,
  arguments_: string[],
): string {
  const command = [executable, ...arguments_].map(quoteCmdArgument).join(' ');
  return `"${command}"`;
}

function quoteCmdArgument(argument: string): string {
  if (/["%!&|<>^()\r\n]/u.test(argument)) {
    throw new Error(
      'Windows .cmd/.bat arguments containing command metacharacters are not supported safely',
    );
  }
  return `"${argument}"`;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
