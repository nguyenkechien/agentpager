import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createGuardPolicy } from '../../../src/core/guard/policy.js';
import { createGuardHook } from '../../../src/providers/claude-code/guardHook.js';
import type { GuardRule } from '../../../src/providers/types.js';

const rules: GuardRule[] = [
  { id: 'force-push-main', pattern: /git\s+push\s+(-f|--force)\b.*\bmain\b/i, reason: 'Force push to main rewrites shared history' },
];

function preToolUse(command: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: 't',
    cwd: 'D:\\Projects',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'u',
  };
}

describe('createGuardHook', () => {
  const signal = new AbortController().signal;

  it('targets shell tools', () => {
    expect(createGuardHook(7, createGuardPolicy(rules, vi.fn())).matcher).toBe('Bash|PowerShell');
  });

  it('denies a blocked command and reports it with the chat id', async () => {
    const onBlock = vi.fn();
    const hook = createGuardHook(7, createGuardPolicy(rules, onBlock)).hooks[0];
    const output = await hook?.(preToolUse('git push -f origin main'), 'u', { signal });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by agentpager guard (force-push-main): Force push to main rewrites shared history',
      },
    });
    expect(onBlock).toHaveBeenCalledOnce();
    expect(onBlock).toHaveBeenCalledWith(7, 'git push -f origin main', expect.objectContaining({ id: 'force-push-main' }));
  });

  it('continues for allowed or non-string commands', async () => {
    const onBlock = vi.fn();
    const hook = createGuardHook(7, createGuardPolicy(rules, onBlock)).hooks[0];
    expect(await hook?.(preToolUse('npm test'), 'u', { signal })).toEqual({ continue: true });
    expect(await hook?.(preToolUse(42), 'u', { signal })).toEqual({ continue: true });
    expect(onBlock).not.toHaveBeenCalled();
  });
});
