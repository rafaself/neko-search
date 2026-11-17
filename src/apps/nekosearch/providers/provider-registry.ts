import { createGrokBuildAdapter } from './adapters/grok.adapter.js';
import type {
  McpProviderAdapter,
  McpProviderRuntime,
} from './provider.types.js';

export function createSetupProviderRegistry(
  runtime: Partial<McpProviderRuntime> = {},
): McpProviderAdapter[] {
  return [createGrokBuildAdapter(runtime)];
}
