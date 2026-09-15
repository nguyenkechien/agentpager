import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelogSection } from './changelog.js';

/** `tsx scripts/release/releaseNotes.ts 0.1.0 notes.md` — the changelog section plus install notes for the release page. */
const appRoot = join(import.meta.dirname, '..', '..');
const [version, outFile] = process.argv.slice(2);
if (version === undefined || outFile === undefined) {
  console.error('Usage: releaseNotes.ts <version> <file>');
  process.exit(2);
}
const section = changelogSection(readFileSync(join(appRoot, 'CHANGELOG.md'), 'utf8'), version);
if (section === null) {
  console.error(`apps/desktop/CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}
const install = [
  '',
  '### Install',
  '',
  `- **Windows**: download \`agentpager-Setup-${version}.exe\`. The installer is not signed: SmartScreen shows "Windows protected your PC" → **More info** → **Run anyway**. Later versions update automatically.`,
  `- **macOS**: download \`agentpager-${version}-arm64.dmg\` (Apple Silicon) or \`agentpager-${version}-x64.dmg\` (Intel) and drag agentpager to Applications. On first launch: System Settings → Privacy & Security → **Open Anyway** (or \`xattr -dr com.apple.quarantine /Applications/agentpager.app\`).`,
  '',
  'Full guide: [apps/desktop/README.md](https://github.com/nguyenkechien/agentpager/blob/main/apps/desktop/README.md).',
];
writeFileSync(outFile, `${section}\n${install.join('\n')}\n`, 'utf8');
console.log(`Wrote the ${version} release notes to ${outFile}.`);
