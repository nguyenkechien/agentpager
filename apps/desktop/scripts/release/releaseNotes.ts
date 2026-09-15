import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelogSection } from './changelog.js';

/** `tsx scripts/release/releaseNotes.ts 0.1.0 notes.md` — the changelog section plus install notes for the release page. */
const appRoot = join(import.meta.dirname, '..', '..');
const [version, outFile] = process.argv.slice(2);
if (version === undefined || outFile === undefined) {
  console.error('Cách dùng: releaseNotes.ts <version> <file>');
  process.exit(2);
}
const section = changelogSection(readFileSync(join(appRoot, 'CHANGELOG.md'), 'utf8'), version);
if (section === null) {
  console.error(`apps/desktop/CHANGELOG.md chưa có mục "## ${version}".`);
  process.exit(1);
}
const install = [
  '',
  '### Cài đặt',
  '',
  `- **Windows**: tải \`agentpager-Setup-${version}.exe\`. Bộ cài chưa ký số: SmartScreen hiện "Windows protected your PC" → **More info** → **Run anyway**. Các bản sau app tự cập nhật.`,
  `- **macOS**: tải \`agentpager-${version}-arm64.dmg\` (Apple Silicon) hoặc \`agentpager-${version}-x64.dmg\` (Intel), kéo agentpager vào Applications. Lần đầu mở: System Settings → Privacy & Security → **Open Anyway** (hoặc \`xattr -dr com.apple.quarantine /Applications/agentpager.app\`).`,
  '',
  'Hướng dẫn đầy đủ: [apps/desktop/README.md](https://github.com/nguyenkechien/agentpager/blob/main/apps/desktop/README.md).',
];
writeFileSync(outFile, `${section}\n${install.join('\n')}\n`, 'utf8');
console.log(`Đã ghi ghi chú phát hành ${version} vào ${outFile}.`);
