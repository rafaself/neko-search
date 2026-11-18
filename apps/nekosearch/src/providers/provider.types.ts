import type { NekosearchStdioCommand } from '../mcp-command.js';
import type { ProviderCommandRunner } from './provider-runner.js';

export type McpProviderId = 'grok-build' | 'codex' | 'claude-code' | 'cursor';
export type McpRegistrationScope =
  'user' | 'project' | 'workspace' | 'plugin' | 'managed' | 'unknown';

export interface McpProviderRegistration {
  name: string;
  scope: McpRegistrationScope;
  origin: string;
  transport: 'stdio' | 'other' | 'unknown';
  command?: string;
  args?: string[];
  customized?: boolean;
}

export interface McpProviderRuntime {
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  runner: ProviderCommandRunner;
}

export interface McpProviderAdapter {
  readonly id: McpProviderId;
  readonly label: string;
  readonly target: string;
  detect(): string | undefined;
  inspect(): Promise<McpProviderRegistration[]>;
  add(serverCommand: NekosearchStdioCommand): Promise<void>;
  remove(name: string, serverCommand: NekosearchStdioCommand): Promise<void>;
}
