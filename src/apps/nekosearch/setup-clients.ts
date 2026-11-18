import { homedir } from 'node:os';
import { createSetupProviderRegistry } from './providers/provider-registry.js';
import { providerCommandRunner } from './providers/provider-runner.js';
import type {
  McpProviderAdapter,
  McpProviderId,
  McpProviderRuntime,
} from './providers/provider.types.js';
import type { NekosearchStdioCommand } from './mcp-command.js';

export type SetupClientId = McpProviderId;

export type SetupClientState =
  'ready' | 'already-configured' | 'conflict' | 'unsupported';

export type SetupClientConfigurationState = 'managed' | 'unknown';
export type SetupClientRegistrationState =
  'missing' | 'configured' | 'conflict' | 'unknown';

export interface SetupClientStatus {
  id: SetupClientId;
  label: string;
  state: SetupClientState;
  application: 'detected';
  configuration: SetupClientConfigurationState;
  registration: SetupClientRegistrationState;
  setupMode: 'automatic' | 'unsupported';
  scope: 'user';
  target: string;
  reason?: string;
}

export interface SetupClientOptions {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  serverCommand: NekosearchStdioCommand;
  providerRunner?: McpProviderRuntime['runner'];
}

export type SetupClientConfigurationResult = 'added' | 'unchanged';
export type SetupClientRemovalResult = 'removed' | 'unchanged';

interface ResolvedSetupClientOptions {
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  serverCommand: NekosearchStdioCommand;
  providerRunner: McpProviderRuntime['runner'];
}

export async function inspectSetupClients(
  options: SetupClientOptions,
): Promise<SetupClientStatus[]> {
  const resolved = resolveOptions(options);
  const adapters = createAdapters(resolved);
  const statuses: SetupClientStatus[] = [];

  for (const adapter of adapters) {
    if (!adapter.detect()) continue;
    try {
      statuses.push(
        statusForRegistrations(adapter, await adapter.inspect(), resolved),
      );
    } catch (error) {
      statuses.push({
        id: adapter.id,
        label: adapter.label,
        state: 'unsupported',
        application: 'detected',
        configuration: 'unknown',
        registration: 'unknown',
        setupMode: 'unsupported',
        scope: 'user',
        target: adapter.target,
        reason: `The provider configuration cannot be inspected safely: ${errorMessage(error)}`,
      });
    }
  }
  return statuses;
}

export async function configureSetupClient(
  id: string,
  options: SetupClientOptions,
): Promise<SetupClientConfigurationResult> {
  const resolved = resolveOptions(options);
  const adapter = findAdapter(id, resolved);
  const status = statusForRegistrations(
    adapter,
    await adapter.inspect(),
    resolved,
  );
  if (status.state === 'already-configured') return 'unchanged';
  if (status.state !== 'ready') {
    throw new Error(status.reason ?? `${adapter.label} is not ready for setup`);
  }
  await adapter.add(resolved.serverCommand);
  return 'added';
}

export async function removeSetupClient(
  id: string,
  options: SetupClientOptions,
): Promise<SetupClientRemovalResult> {
  const resolved = resolveOptions(options);
  const adapter = findAdapter(id, resolved);
  const status = statusForRegistrations(
    adapter,
    await adapter.inspect(),
    resolved,
  );
  if (status.registration === 'missing') return 'unchanged';
  if (status.state !== 'already-configured') {
    throw new Error(
      status.reason ??
        `Refusing to remove an unverified ${adapter.label} registration`,
    );
  }
  await adapter.remove('nekosearch', resolved.serverCommand);
  return 'removed';
}

function statusForRegistrations(
  adapter: McpProviderAdapter,
  registrations: Awaited<ReturnType<McpProviderAdapter['inspect']>>,
  options: ResolvedSetupClientOptions,
): SetupClientStatus {
  const matches = registrations.filter(({ name }) => name === 'nekosearch');
  if (matches.length === 0) {
    return {
      id: adapter.id,
      label: adapter.label,
      state: 'ready',
      application: 'detected',
      configuration: 'managed',
      registration: 'missing',
      setupMode: 'automatic',
      scope: 'user',
      target: adapter.target,
    };
  }

  if (
    matches.length === 1 &&
    matches[0]?.scope === 'user' &&
    matches[0]?.transport === 'stdio' &&
    !matches[0]?.customized &&
    matches[0]?.command === options.serverCommand.command &&
    sameArguments(matches[0]?.args, options.serverCommand.args)
  ) {
    return {
      id: adapter.id,
      label: adapter.label,
      state: 'already-configured',
      application: 'detected',
      configuration: 'managed',
      registration: 'configured',
      setupMode: 'automatic',
      scope: 'user',
      target: adapter.target,
    };
  }

  const registration = matches[0];
  const reason =
    matches.length > 1
      ? `Multiple registrations named nekosearch are visible across ${adapter.label} scopes`
      : registration?.scope === 'unknown'
        ? `${adapter.label} did not report the origin of its nekosearch registration`
        : registration?.scope !== 'user'
          ? `The nekosearch registration belongs to the ${registration?.scope ?? 'unknown'} scope`
          : 'A different nekosearch MCP registration already exists';
  return {
    id: adapter.id,
    label: adapter.label,
    state: 'conflict',
    application: 'detected',
    configuration: 'managed',
    registration: registration?.scope === 'unknown' ? 'unknown' : 'conflict',
    setupMode: 'automatic',
    scope: 'user',
    target: adapter.target,
    reason,
  };
}

function createAdapters(
  options: ResolvedSetupClientOptions,
): McpProviderAdapter[] {
  return createSetupProviderRegistry({
    homeDirectory: options.homeDirectory,
    environment: options.environment,
    platform: options.platform,
    runner: options.providerRunner,
  });
}

function findAdapter(
  id: string,
  options: ResolvedSetupClientOptions,
): McpProviderAdapter {
  const adapter = createAdapters(options).find(
    (candidate) => candidate.id === id,
  );
  if (!adapter) throw new Error(`Unknown MCP provider ${id}`);
  if (!adapter.detect())
    throw new Error(`${adapter.label} was not detected on PATH`);
  return adapter;
}

function resolveOptions(
  options: SetupClientOptions,
): ResolvedSetupClientOptions {
  const homeDirectory = options.homeDirectory ?? homedir();
  const environment = {
    ...process.env,
    ...options.environment,
    HOME: options.environment?.HOME ?? homeDirectory,
  };
  return {
    homeDirectory,
    environment,
    platform: options.platform ?? process.platform,
    serverCommand: options.serverCommand,
    providerRunner: options.providerRunner ?? providerCommandRunner,
  };
}

function sameArguments(
  actual: string[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
