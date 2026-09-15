/** The body of `## <version>` (a heading may carry a date: `## 0.1.0 — 2026-09-15`), up to the next `## ` heading. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

/** Everything wrong with releasing `tag` from a package at `version`. */
export function tagProblems(tag: string, version: string, changelog: string): string[] {
  const problems: string[] = [];
  if (tag !== `v${version}`) problems.push(`Tag ${tag} không khớp phiên bản app ${version} (cần v${version}).`);
  if (changelogSection(changelog, version) === null) problems.push(`apps/desktop/CHANGELOG.md chưa có mục "## ${version}".`);
  return problems;
}
