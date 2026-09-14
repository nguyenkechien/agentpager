import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPackageRoot, readPackageVersion } from '../../src/daemon/packageRoot.js';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('findPackageRoot', () => {
  it('walks up to the nearest folder with package.json', () => {
    const exists = (path: string): boolean => path === join('/opt/app', 'package.json');
    expect(findPackageRoot('/opt/app/dist/src/daemon', exists)).toBe('/opt/app');
    expect(findPackageRoot(join(repoRoot, 'src', 'daemon'))).toBe(repoRoot);
  });

  it('fails when no package.json exists up to the filesystem root', () => {
    const start = join(parse(repoRoot).root, 'nowhere', 'deep');
    expect(() => findPackageRoot(start, () => false)).toThrow('package.json not found above');
  });
});

describe('readPackageVersion', () => {
  it('reads the version of this package', async () => {
    await expect(readPackageVersion(repoRoot)).resolves.toMatch(/^\d+\.\d+\.\d+/);
  });
});
