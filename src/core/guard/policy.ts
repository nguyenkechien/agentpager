import { z } from 'zod';
import type { GuardPolicy, GuardRule } from '../../providers/types.js';

export class GuardRulesError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid guard rules:\n- ${issues.join('\n- ')}`);
    this.name = 'GuardRulesError';
    this.issues = issues;
  }
}

export function matchGuard(command: string, rules: readonly GuardRule[]): GuardRule | null {
  return rules.find((rule) => rule.pattern.test(command)) ?? null;
}

export function createGuardPolicy(rules: readonly GuardRule[], onBlock: GuardPolicy['onBlock']): GuardPolicy {
  return { match: (command) => matchGuard(command, rules), onBlock };
}

const guardRuleSchema = z.array(
  z.object({
    id: z.string().min(1),
    pattern: z.string().min(1),
    reason: z.string().min(1),
  }),
);

export function parseGuardRules(json: string): GuardRule[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new GuardRulesError([`guard rules file is not valid JSON: ${(error as Error).message}`]);
  }

  const parsed = guardRuleSchema.safeParse(data);
  if (!parsed.success) {
    throw new GuardRulesError(parsed.error.issues.map((issue) => `guard rules ${issue.path.join('.')}: ${issue.message}`));
  }

  const issues: string[] = [];
  const seen = new Set<string>();
  const rules: GuardRule[] = [];
  for (const rule of parsed.data) {
    if (seen.has(rule.id)) {
      issues.push(`guard rules have a duplicate rule id: ${rule.id}`);
      continue;
    }
    seen.add(rule.id);
    try {
      rules.push({ id: rule.id, pattern: new RegExp(rule.pattern, 'i'), reason: rule.reason });
    } catch (error) {
      issues.push(`guard rule "${rule.id}" has an invalid pattern: ${(error as Error).message}`);
    }
  }
  if (issues.length > 0) throw new GuardRulesError(issues);
  return rules;
}
