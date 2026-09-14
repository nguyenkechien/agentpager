import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const FORBIDDEN_IMPORTS = [/^@anthropic-ai\/claude-agent-sdk/, /providers\/claude-code/];

function collectTypeScript(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return collectTypeScript(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

describe('provider boundary', () => {
  it('keeps provider types and the core free of concrete provider imports', () => {
    const files = [join(root, 'src', 'providers', 'types.ts'), ...collectTypeScript(join(root, 'src', 'core'))];
    const offenders = files.flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${relative(root, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('detects a forbidden import', () => {
    expect(importSpecifiers("import { query } from '@anthropic-ai/claude-agent-sdk';")).toEqual([
      '@anthropic-ai/claude-agent-sdk',
    ]);
    expect(importSpecifiers("export { x } from '../providers/claude-code/index.js';")).toEqual([
      '../providers/claude-code/index.js',
    ]);
  });
});
