import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { GuardPolicy } from '../types.js';

function commandOf(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null || !('command' in toolInput)) return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

export function createGuardHook(chatId: number, guard: GuardPolicy): HookCallbackMatcher {
  return {
    matcher: 'Bash|PowerShell',
    hooks: [
      (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({ continue: true });
        const command = commandOf(input.tool_input);
        if (command === null) return Promise.resolve({ continue: true });

        const rule = guard.match(command);
        if (!rule) return Promise.resolve({ continue: true });

        guard.onBlock(chatId, command, rule);
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Blocked by agentpager guard (${rule.id}): ${rule.reason}`,
          },
        });
      },
    ],
  };
}
