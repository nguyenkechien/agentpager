import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetProblems, setupFileName } from './releaseAssets.js';

/** `tsx scripts/release/checkReleaseAssets.ts v0.1.0` (needs `gh` and GH_TOKEN) — the draft has exactly the right files. */
const tag = process.argv[2];
if (tag === undefined) {
  console.error('Cách dùng: checkReleaseAssets.ts <tag>');
  process.exit(2);
}
const version = tag.replace(/^v/, '');
const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' });

const { assets } = JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])) as { assets: { name: string }[] };
const dir = mkdtempSync(join(tmpdir(), 'agentpager-release-'));
gh(['release', 'download', tag, '--dir', dir, '--pattern', 'latest.yml', '--pattern', setupFileName(version)]);
const setupSha512 = createHash('sha512').update(readFileSync(join(dir, setupFileName(version)))).digest('base64');

const problems = assetProblems({
  version,
  names: assets.map((asset) => asset.name),
  latestYml: readFileSync(join(dir, 'latest.yml'), 'utf8'),
  setupSha512,
});
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`Bản nháp ${tag} có đủ file và latest.yml khớp bộ cài.`);
