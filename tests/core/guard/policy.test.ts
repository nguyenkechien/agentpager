import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGuardPolicy, GuardRulesError, matchGuard, parseGuardRules } from '../../../src/core/guard/policy.js';

const rules = parseGuardRules(readFileSync(join(import.meta.dirname, '..', '..', '..', 'guard-rules.json'), 'utf8'));

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

function issuesOf(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof GuardRulesError) return error.issues;
    throw error;
  }
  return [];
}

describe('matchGuard', () => {
  it.each(blocked)('blocks %j via %s', (command, ruleId) => {
    expect(matchGuard(command, rules)?.id).toBe(ruleId);
  });

  it.each(allowed)('allows %j', (command) => {
    expect(matchGuard(command, rules)).toBeNull();
  });
});

describe('createGuardPolicy', () => {
  it('matches against its rules and exposes the block callback', () => {
    const onBlock = vi.fn();
    const policy = createGuardPolicy(rules, onBlock);
    expect(policy.match('git push -f origin main')?.id).toBe('force-push-main');
    expect(policy.match('npm test')).toBeNull();
    policy.onBlock(7, 'x', { id: 'r', pattern: /x/, reason: 'why' });
    expect(onBlock).toHaveBeenCalledWith(7, 'x', { id: 'r', pattern: /x/, reason: 'why' });
  });
});

describe('parseGuardRules', () => {
  it('compiles case-insensitive patterns', () => {
    const parsed = parseGuardRules(JSON.stringify([{ id: 'x', pattern: 'danger', reason: 'bad' }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.pattern.test('DANGER zone')).toBe(true);
  });

  it('reports invalid patterns by rule id', () => {
    expect(issuesOf(() => parseGuardRules(JSON.stringify([{ id: 'broken', pattern: '(', reason: 'r' }]))).join()).toMatch(
      /broken/,
    );
  });

  it('rejects invalid JSON and missing fields', () => {
    expect(issuesOf(() => parseGuardRules('not json')).length).toBeGreaterThan(0);
    expect(issuesOf(() => parseGuardRules(JSON.stringify([{ id: 'x' }]))).length).toBeGreaterThan(0);
  });

  it('rejects duplicate ids', () => {
    const json = JSON.stringify([
      { id: 'x', pattern: 'a', reason: 'r' },
      { id: 'x', pattern: 'b', reason: 'r' },
    ]);
    expect(issuesOf(() => parseGuardRules(json)).join()).toMatch(/duplicate/i);
  });
});
