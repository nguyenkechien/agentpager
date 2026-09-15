import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tagProblems } from './changelog.js';

/** `tsx scripts/release/checkReleaseTag.ts v0.1.0` — the tag, the app version and the changelog agree. */
const appRoot = join(import.meta.dirname, '..', '..');
const tag = process.argv[2];
if (tag === undefined) {
  console.error('Cách dùng: checkReleaseTag.ts <tag>');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string };
const problems = tagProblems(tag, version, readFileSync(join(appRoot, 'CHANGELOG.md'), 'utf8'));
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`${tag} khớp agentpager app ${version}.`);
