import { load } from 'js-yaml';
import { z } from 'zod';

export function setupFileName(version: string): string {
  return `agentpager-Setup-${version}.exe`;
}

/** Exactly the files a draft release carries. */
export function expectedAssets(version: string): string[] {
  const setup = setupFileName(version);
  return [setup, `${setup}.blockmap`, 'latest.yml', `agentpager-${version}-arm64.dmg`, `agentpager-${version}-x64.dmg`];
}

const latestSchema = z.object({
  version: z.string(),
  files: z.array(z.object({ url: z.string(), sha512: z.string() })).min(1),
  path: z.string(),
  sha512: z.string(),
});

export interface AssetCheck {
  version: string;
  /** Asset names on the release. */
  names: readonly string[];
  latestYml: string;
  /** Base64 SHA-512 of the uploaded setup file, the format electron-updater verifies. */
  setupSha512: string;
}

export function assetProblems(check: AssetCheck): string[] {
  const problems: string[] = [];
  const expected = expectedAssets(check.version);
  for (const name of expected) if (!check.names.includes(name)) problems.push(`Thiếu ${name}.`);
  for (const name of check.names) if (!expected.includes(name)) problems.push(`Thừa ${name}.`);

  let latest: z.infer<typeof latestSchema>;
  try {
    latest = latestSchema.parse(load(check.latestYml));
  } catch (error) {
    problems.push(`latest.yml không đọc được: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }
  const setup = setupFileName(check.version);
  if (latest.version !== check.version) problems.push(`latest.yml ghi phiên bản ${latest.version}, cần ${check.version}.`);
  if (latest.path !== setup || latest.files[0]?.url !== setup) problems.push(`latest.yml không trỏ tới ${setup}.`);
  if (latest.sha512 !== check.setupSha512 || latest.files[0]?.sha512 !== check.setupSha512) {
    problems.push(`SHA-512 trong latest.yml không khớp ${setup} đã tải lên.`);
  }
  return problems;
}
