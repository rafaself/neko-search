import { createClaudeCodeAdapter } from './adapters/claude-code.adapter.js';
import { createCodexAdapter } from './adapters/codex.adapter.js';
import { createCursorAdapter } from './adapters/cursor.adapter.js';
import { createGrokBuildAdapter } from './adapters/grok.adapter.js';
import type {
  McpProviderAdapter,
  McpProviderRuntime,
} from './provider.types.js';

export function createSetupProviderRegistry(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter[] {
  return [
    createGrokBuildAdapter(runtime),
    createCodexAdapter(runtime),
    createClaudeCodeAdapter(runtime),
    createCursorAdapter(runtime),
  ];
}
