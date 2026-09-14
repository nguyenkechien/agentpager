import { claudeCodeCatalog, createClaudeCodeProvider } from './claude-code/index.js';
import type { AgentProvider, ProviderCatalogEntry, ProviderContext, ProviderFactory, ProviderSettings } from './types.js';

export class UnknownProviderError extends Error {
  readonly knownIds: string[];

  constructor(id: string, knownIds: string[]) {
    super(`Unknown agent provider "${id}". Known providers: ${knownIds.join(', ')}`);
    this.name = 'UnknownProviderError';
    this.knownIds = knownIds;
  }
}

const FACTORIES = new Map<string, ProviderFactory>([[claudeCodeCatalog.id, createClaudeCodeProvider]]);

export const providerCatalog: readonly ProviderCatalogEntry[] = [claudeCodeCatalog];

export function findCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return providerCatalog.find((entry) => entry.id === id);
}

export function createProvider(id: string, settings: ProviderSettings, context: ProviderContext): AgentProvider {
  const factory = FACTORIES.get(id);
  if (!factory) throw new UnknownProviderError(id, [...FACTORIES.keys()]);
  return factory(settings, context);
}
