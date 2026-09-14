import { homedir } from 'node:os';
import type { ModelOption, ProviderCapabilities, ProviderCatalogEntry, ProviderFactory } from '../types.js';
import { defaultDetectDeps, detectClaudeCode } from './detect.js';
import { claudeSessionSource } from './history.js';
import { startClaudeTurn } from './runner.js';
import { ClaudeUsageFetcher } from './usage.js';

export const CLAUDE_CODE_MODELS: readonly ModelOption[] = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

export const CLAUDE_CODE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const CAPABILITIES: ProviderCapabilities = {
  interrupt: 'native',
  approvals: true,
  askUser: true,
  sessionListing: true,
  commandGuard: true,
  fileSendTool: true,
  imageInput: 'native',
  usage: 'plan-limits',
};

export const claudeCodeCatalog: ProviderCatalogEntry = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: CAPABILITIES,
  models: CLAUDE_CODE_MODELS,
  efforts: CLAUDE_CODE_EFFORTS,
  detect: (settings) => detectClaudeCode(settings, defaultDetectDeps()),
};

export const createClaudeCodeProvider: ProviderFactory = (settings, context) => {
  const usage = new ClaudeUsageFetcher({ executable: settings.executable, cwd: homedir(), logger: context.logger });
  return {
    ...claudeCodeCatalog,
    startTurn: (request, sink) => startClaudeTurn(settings, context, request, sink),
    sessions: claudeSessionSource,
    fetchUsage: () => usage.fetch(),
  };
};
