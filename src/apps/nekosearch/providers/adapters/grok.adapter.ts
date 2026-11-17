import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { NekosearchStdioCommand } from '../../mcp-command.js';
import {
  providerCommandRunner,
  type ProviderCommandRunner,
} from '../provider-runner.js';
import type {
  McpProviderAdapter,
  McpProviderRegistration,
  McpProviderRuntime,
  McpRegistrationScope,
} from '../provider.types.js';

const PROVIDER_ID = 'grok-build';
const PROVIDER_LABEL = 'Grok Build CLI';
const MCP_NAME = 'nekosearch';

export function createGrokBuildAdapter(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter {
  const environment = runtime.environment ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const runner = runtime.runner ?? providerCommandRunner;

  const adapter: McpProviderAdapter = {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    detect: () => runner.resolve('grok', environment, platform),
    async inspect() {
      const executable = requireGrokCli(adapter, environment, platform, runner);
      const { stdout } = await runner.run(executable, ['inspect', '--json'], {
        environment,
        platform,
        cwd: tmpdir(),
      });
      return parseGrokInspectionOutput(stdout, environment, platform);
    },
    async add(serverCommand) {
      assertServerCommand(serverCommand);
      const current = await adapter.inspect();
      assertCanAdd(current, serverCommand);

      const executable = requireGrokCli(adapter, environment, platform, runner);
      await runner.run(
        executable,
        [
          'mcp',
          'add',
          '--scope',
          'user',
          MCP_NAME,
          '--',
          serverCommand.command,
          ...serverCommand.args,
        ],
        { environment, platform, cwd: tmpdir() },
      );

      const added = await adapter.inspect();
      const registrations = added.filter(({ name }) => name === MCP_NAME);
      if (
        registrations.length !== 1 ||
        registrations[0]?.scope !== 'user' ||
        !matchesNekosearchCommand(registrations[0], serverCommand)
      ) {
        throw new Error(
          'Grok Build did not report the NekoSearch user registration after adding it; inspect Grok MCP configuration before retrying',
        );
      }
    },
    async remove(name, serverCommand) {
      if (name !== MCP_NAME) {
        throw new Error(`Grok Build removal is limited to ${MCP_NAME}`);
      }
      assertServerCommand(serverCommand);
      const current = await adapter.inspect();
      const registrations = current.filter(
        ({ name: itemName }) => itemName === name,
      );
      if (registrations.length === 0) return;
      if (
        registrations.length !== 1 ||
        registrations[0]?.scope !== 'user' ||
        !matchesNekosearchCommand(registrations[0], serverCommand)
      ) {
        throw new Error(
          'Grok Build has a same-name MCP registration that does not match the NekoSearch user registration; refusing to remove it',
        );
      }
      const executable = requireGrokCli(adapter, environment, platform, runner);
      await runner.run(executable, ['mcp', 'remove', '--scope', 'user', name], {
        environment,
        platform,
        cwd: tmpdir(),
      });
      const remaining = (await adapter.inspect()).filter(
        ({ name: itemName }) => itemName === name,
      );
      if (remaining.length > 0) {
        throw new Error(
          'Grok Build still reports the NekoSearch MCP registration after removal',
        );
      }
    },
  };
  return adapter;
}

export function parseGrokInspectionOutput(
  output: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): McpProviderRegistration[] {
  let root: unknown;
  try {
    root = JSON.parse(output) as unknown;
  } catch (cause) {
    throw new Error('Grok inspect did not return valid JSON', { cause });
  }

  const collections = findMcpCollections(root);
  if (collections.length !== 1) {
    throw new Error(
      'Grok inspect returned an unsupported or ambiguous MCP registration structure',
    );
  }
  const collection = collections.at(0);
  if (!collection) {
    throw new Error('Grok inspect returned no MCP registration list');
  }
  if (Array.isArray(collection.value)) {
    return collection.value.map((item) =>
      parseRegistration(item, undefined, environment, platform),
    );
  }
  if (!isRecord(collection.value)) {
    throw new Error('Grok inspect returned an invalid MCP registration list');
  }
  return Object.entries(collection.value).map(([name, item]) =>
    parseRegistration(item, name, environment, platform),
  );
}

interface NamedCollection {
  key: string;
  value: unknown;
}

function findMcpCollections(root: unknown): NamedCollection[] {
  const matches: NamedCollection[] = [];
  const seen = new Set<object>();
  const recognizedKeys = new Set(['mcpServers', 'mcp_servers', 'mcps']);

  const visit = (value: unknown): void => {
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (recognizedKeys.has(key)) matches.push({ key, value: child });
      else if (key === 'mcp' && isRecord(child) && 'servers' in child) {
        matches.push({ key, value: child.servers });
      } else visit(child);
    }
  };
  visit(root);
  return matches;
}

function parseRegistration(
  value: unknown,
  mapName: string | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): McpProviderRegistration {
  if (!isRecord(value)) {
    throw new Error('Grok inspect returned an invalid MCP registration');
  }
  const name = typeof value.name === 'string' ? value.name : mapName;
  if (!name) {
    throw new Error('Grok inspect returned an MCP registration without a name');
  }

  const config = isRecord(value.config)
    ? value.config
    : isRecord(value.configuration)
      ? value.configuration
      : value;
  const originValue =
    value.origin ?? value.source ?? config.origin ?? config.source;
  const declaredScope = value.scope ?? config.scope;
  const origin = formatOrigin(originValue ?? declaredScope);
  const scope = identifyScope(
    originValue,
    declaredScope,
    origin,
    environment,
    platform,
  );
  const transportValue = config.transport ?? config.type;
  const transportConfig = isRecord(transportValue) ? transportValue : config;
  const transport =
    transportValue === 'stdio' ||
    (isRecord(transportValue) && transportValue.type === 'stdio')
      ? 'stdio'
      : transportValue === undefined
        ? 'unknown'
        : 'other';
  const commandValue = config.command ?? transportConfig.command;
  const argsValue = config.args ?? transportConfig.args;
  const command = typeof commandValue === 'string' ? commandValue : undefined;
  const args =
    Array.isArray(argsValue) && argsValue.every(isString)
      ? argsValue
      : undefined;

  return {
    name,
    scope,
    origin,
    transport,
    ...(command && { command }),
    ...(args && { args }),
  };
}

function identifyScope(
  originValue: unknown,
  declaredScope: unknown,
  origin: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): McpRegistrationScope {
  const configPath = resolve(
    environment.GROK_HOME || join(environment.HOME || '', '.grok'),
    'config.toml',
  );
  const originPath = originPathFrom(originValue, origin, environment);
  if (originPath) {
    if (samePath(originPath, configPath, platform)) return 'user';
    if (/(?:^|[\\/])\.grok[\\/]config\.toml$/iu.test(originPath)) {
      return 'project';
    }
    return 'unknown';
  }

  const sourceScope =
    isRecord(originValue) && isString(originValue.scope)
      ? originValue.scope.toLowerCase()
      : typeof originValue === 'string'
        ? originValue.toLowerCase()
        : '';
  const candidate =
    sourceScope || (isString(declaredScope) ? declaredScope.toLowerCase() : '');
  if (candidate.includes('project')) return 'project';
  if (candidate.includes('workspace')) return 'workspace';
  if (candidate.includes('plugin')) return 'plugin';
  if (candidate.includes('managed') || candidate.includes('policy'))
    return 'managed';
  return 'unknown';
}

function originPathFrom(
  originValue: unknown,
  origin: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const pathValue =
    typeof originValue === 'string'
      ? originValue
      : isRecord(originValue)
        ? [originValue.path, originValue.file, originValue.configPath].find(
            isString,
          )
        : undefined;
  const value = pathValue ?? origin;
  if (value.startsWith('~/')) {
    return resolve(environment.HOME || '', value.slice(2));
  }
  if (isAbsolute(value)) return resolve(value);
  return undefined;
}

function formatOrigin(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const text = [value.scope, value.path, value.file, value.configPath].find(
      isString,
    );
    return text ?? 'unknown';
  }
  return 'unknown';
}

function assertCanAdd(
  registrations: McpProviderRegistration[],
  command: NekosearchStdioCommand,
): void {
  const named = registrations.filter(({ name }) => name === MCP_NAME);
  if (named.length === 0) return;
  if (
    named.length === 1 &&
    named[0]?.scope === 'user' &&
    matchesNekosearchCommand(named[0], command)
  ) {
    throw new Error('NekoSearch is already configured with Grok Build');
  }
  throw new Error(
    'Grok Build already has a conflicting or externally managed nekosearch MCP registration; it was left unchanged',
  );
}

function requireGrokCli(
  adapter: McpProviderAdapter,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runner: ProviderCommandRunner,
): string {
  const executable = runner.resolve('grok', environment, platform);
  if (!executable) throw new Error(`${adapter.label} was not detected on PATH`);
  return executable;
}

function assertServerCommand(command: NekosearchStdioCommand): void {
  if (
    !isAbsolute(command.command) ||
    !isAbsolute(command.args[0]) ||
    command.args[1] !== 'serve'
  ) {
    throw new Error(
      'NekoSearch MCP command and CLI path must be absolute and end with serve',
    );
  }
}

function matchesNekosearchCommand(
  registration: McpProviderRegistration | undefined,
  command: NekosearchStdioCommand,
): boolean {
  return (
    registration?.transport === 'stdio' &&
    registration.command === command.command &&
    registration.args?.length === command.args.length &&
    registration.args.every(
      (argument, index) => argument === command.args[index],
    )
  );
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (path: string): string =>
    platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
