import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createGuardPolicy } from '../../src/core/guard/policy.js';
import { createProvider, findCatalogEntry, providerCatalog, UnknownProviderError } from '../../src/providers/registry.js';
import type { ProviderContext } from '../../src/providers/types.js';

const context: ProviderContext = {
  guard: createGuardPolicy([], vi.fn()),
  fileSender: { sendPhoto: () => Promise.resolve(), sendDocument: () => Promise.resolve() },
  prompts: {
    askUser: () => Promise.resolve({ declined: 'no' }),
    requestApproval: () => Promise.resolve({ allow: false, message: 'no' }),
  },
  systemPrompt: '',
  logger: pino({ level: 'silent' }),
};

describe('provider registry', () => {
  it('lists claude-code in the catalog', () => {
    expect(providerCatalog.map((entry) => entry.id)).toEqual(['claude-code']);
    expect(findCatalogEntry('claude-code')?.displayName).toBe('Claude Code');
    expect(findCatalogEntry('codex')).toBeUndefined();
  });

  it('creates the claude-code provider with its optional features', () => {
    const provider = createProvider('claude-code', { executable: null }, context);
    expect(provider.id).toBe('claude-code');
    expect(provider.sessions).toBeDefined();
    expect(provider.fetchUsage).toBeTypeOf('function');
    expect(provider.models.map((model) => model.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('rejects unknown provider ids and names the known ones', () => {
    let caught: unknown;
    try {
      createProvider('codex', { executable: null }, context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownProviderError);
    expect((caught as UnknownProviderError).knownIds).toEqual(['claude-code']);
  });
});
