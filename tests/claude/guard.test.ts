import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createGuardHook, matchGuard } from '../../src/claude/guard.js';
import { parseGuardRules } from '../../src/config.js';

const rules = parseGuardRules(readFileSync(join(import.meta.dirname, '..', '..', 'guard-rules.json'), 'utf8'));

const blocked: [string, string][] = [
  ['format D:', 'disk-format'],
  ['Format-Volume -DriveLetter D', 'disk-format'],
  ['diskpart /s script.txt', 'disk-format'],
  ['Clear-Disk -Number 1 -RemoveData', 'disk-format'],
  ['rm -rf /', 'recursive-delete-root'],
  ['rm -rf ~', 'recursive-delete-root'],
  ['rm -rf $HOME', 'recursive-delete-root'],
  ['rm -fr C:\\', 'recursive-delete-root'],
  ['rm -rf /c/Users/chien', 'recursive-delete-root'],
  ['rm -r --force /d', 'recursive-delete-root'],
  ['Remove-Item -Recurse -Force C:\\Users\\chien', 'recursive-delete-root'],
  ['Remove-Item C:\\ -Recurse', 'recursive-delete-root'],
  ['Remove-Item -Recurse -Force $env:USERPROFILE', 'recursive-delete-root'],
  ['rd /s /q D:\\', 'recursive-delete-root'],
  ['rmdir /s C:\\Windows', 'recursive-delete-root'],
  ['del /f /s C:\\', 'recursive-delete-root'],
  ['cd x && rm -rf "C:/"', 'recursive-delete-root'],
  ['git push --force origin main', 'force-push-main'],
  ['git push -f origin master', 'force-push-main'],
  ['git push origin main --force-with-lease', 'force-push-main'],
  ['git push --force origin HEAD:main', 'force-push-main'],
  ['shutdown /r /t 0', 'machine-power'],
  ['Restart-Computer', 'machine-power'],
  ['Stop-Computer -Force', 'machine-power'],
  ['taskkill /F /IM node.exe', 'kill-bot'],
  ['Stop-Process -Name node', 'kill-bot'],
  ['pkill node', 'kill-bot'],
  // Accepted false positive: the guard is a coarse safety net.
  ['echo shutdown later', 'machine-power'],
];

const allowed = [
  'rm -rf ./dist',
  'rm -rf node_modules',
  'rm -rf /tmp/build-cache',
  'Remove-Item -Recurse .\\build',
  'Remove-Item C:\\temp\\a.txt',
  'rd /s /q D:\\Projects\\tmp',
  'del /s *.log',
  'git push --force origin feature-x',
  'git push origin main',
  'git push -f origin maintenance',
  'npm run format',
  'taskkill /IM chrome.exe',
  'Get-Process node',
  'ls C:\\',
  'dir D:\\Projects',
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

describe('matchGuard', () => {
  it.each(blocked)('blocks %j via %s', (command, ruleId) => {
    expect(matchGuard(command, rules)?.id).toBe(ruleId);
  });

  it.each(allowed)('allows %j', (command) => {
    expect(matchGuard(command, rules)).toBeNull();
  });
});

describe('createGuardHook', () => {
  const signal = new AbortController().signal;

  it('targets shell tools', () => {
    expect(createGuardHook(rules, vi.fn()).matcher).toBe('Bash|PowerShell');
  });

  it('denies a blocked command and reports it', async () => {
    const onBlock = vi.fn();
    const hook = createGuardHook(rules, onBlock).hooks[0];
    const output = await hook?.(preToolUse('git push -f origin main'), 'u', { signal });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Blocked by claude-pager guard (force-push-main): Force push to main/master rewrites shared history',
      },
    });
    expect(onBlock).toHaveBeenCalledOnce();
    expect(onBlock).toHaveBeenCalledWith('git push -f origin main', expect.objectContaining({ id: 'force-push-main' }));
  });

  it('continues for allowed or non-string commands', async () => {
    const onBlock = vi.fn();
    const hook = createGuardHook(rules, onBlock).hooks[0];
    expect(await hook?.(preToolUse('npm test'), 'u', { signal })).toEqual({ continue: true });
    expect(await hook?.(preToolUse(42), 'u', { signal })).toEqual({ continue: true });
    expect(onBlock).not.toHaveBeenCalled();
  });
});
