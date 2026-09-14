import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { GuardRule } from '../config.js';

export function matchGuard(command: string, rules: readonly GuardRule[]): GuardRule | null {
  return rules.find((rule) => rule.pattern.test(command)) ?? null;
}

function commandOf(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

export function createGuardHook(
  rules: readonly GuardRule[],
  onBlock: (command: string, rule: GuardRule) => void,
): HookCallbackMatcher {
  return {
    matcher: 'Bash|PowerShell',
    hooks: [
      (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({ continue: true });
        const command = commandOf(input.tool_input);
        if (command === null) return Promise.resolve({ continue: true });

        const rule = matchGuard(command, rules);
        if (!rule) return Promise.resolve({ continue: true });

        onBlock(command, rule);
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Blocked by claude-pager guard (${rule.id}): ${rule.reason}`,
          },
        });
      },
    ],
  };
}
