import { describe, expect, it } from 'vitest';
import { changelogSection, tagProblems } from '../../../scripts/release/changelog.js';
import { assetProblems, expectedAssets } from '../../../scripts/release/releaseAssets.js';

const CHANGELOG = ['# Changelog', '', '## 0.1.1 — 2026-09-20', '', '- Fix bug A.', '', '## 0.1.0 — 2026-09-15', '', '- First release.', ''].join('\n');

describe('changelogSection', () => {
  it('returns the body of a version heading up to the next heading', () => {
    expect(changelogSection(CHANGELOG, '0.1.1')).toBe('- Fix bug A.');
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe('- First release.');
    expect(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0')).toBe('- First release.');
  });

  it('does not confuse versions that share a prefix, and ignores empty sections', () => {
    expect(changelogSection('## 0.1.10\n\n- x\n', '0.1.1')).toBeNull();
    expect(changelogSection('## 0.2.0\n\n## 0.1.0\n- y', '0.2.0')).toBeNull();
    expect(changelogSection(CHANGELOG, '9.9.9')).toBeNull();
  });
});

describe('tagProblems', () => {
  it('accepts a v-prefixed tag matching the version with a changelog entry', () => {
    expect(tagProblems('v0.1.0', '0.1.0', CHANGELOG)).toEqual([]);
  });

  it('reports a mismatched or unprefixed tag and a missing entry', () => {
    expect(tagProblems('0.1.0', '0.1.0', CHANGELOG)).toEqual(['Tag 0.1.0 does not match app version 0.1.0 (expected v0.1.0).']);
    expect(tagProblems('v0.1.2', '0.1.2', CHANGELOG)).toEqual(['apps/desktop/CHANGELOG.md has no "## 0.1.2" section.']);
    expect(tagProblems('app-v0.1.0', '0.1.1', CHANGELOG)).toHaveLength(1);
  });
});

describe('assetProblems', () => {
  const version = '0.1.0';
  const sha = 'c2hhNTEy';
  const latest = (overrides: { version?: string; url?: string; sha?: string } = {}): string =>
    [
      `version: ${overrides.version ?? version}`,
      'files:',
      `  - url: ${overrides.url ?? 'agentpager-Setup-0.1.0.exe'}`,
      `    sha512: ${overrides.sha ?? sha}`,
      '    size: 191000000',
      `path: ${overrides.url ?? 'agentpager-Setup-0.1.0.exe'}`,
      `sha512: ${overrides.sha ?? sha}`,
      "releaseDate: '2026-09-15T10:00:00.000Z'",
    ].join('\n');

  it('accepts exactly the expected files with a matching latest.yml', () => {
    expect(expectedAssets(version)).toEqual([
      'agentpager-Setup-0.1.0.exe',
      'agentpager-Setup-0.1.0.exe.blockmap',
      'latest.yml',
      'agentpager-0.1.0-arm64.dmg',
      'agentpager-0.1.0-x64.dmg',
    ]);
    expect(assetProblems({ version, names: expectedAssets(version), latestYml: latest(), setupSha512: sha })).toEqual([]);
  });

  it('reports missing and extra files', () => {
    const names = [...expectedAssets(version).filter((name) => !name.endsWith('x64.dmg')), 'latest-mac.yml'];
    expect(assetProblems({ version, names, latestYml: latest(), setupSha512: sha })).toEqual(['Missing agentpager-0.1.0-x64.dmg.', 'Unexpected latest-mac.yml.']);
  });

  it('reports a latest.yml for another version, file or hash', () => {
    const names = expectedAssets(version);
    expect(assetProblems({ version, names, latestYml: latest({ version: '0.0.9' }), setupSha512: sha })).toEqual([
      'latest.yml lists version 0.0.9, expected 0.1.0.',
    ]);
    expect(assetProblems({ version, names, latestYml: latest({ url: 'other.exe' }), setupSha512: sha })).toEqual([
      'latest.yml does not point to agentpager-Setup-0.1.0.exe.',
    ]);
    expect(assetProblems({ version, names, latestYml: latest(), setupSha512: 'ZGlmZmVyZW50' })).toEqual([
      'SHA-512 in latest.yml does not match the uploaded agentpager-Setup-0.1.0.exe.',
    ]);
    expect(assetProblems({ version, names, latestYml: 'just text', setupSha512: sha })[0]).toMatch(/^latest.yml could not be read/);
  });
});
