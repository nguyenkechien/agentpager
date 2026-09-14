import { describe, expect, it } from 'vitest';
import { findOnPath } from '../../src/platform/which.js';

function existsIn(files: string[]): (path: string) => Promise<boolean> {
  const set = new Set(files);
  return (path) => Promise.resolve(set.has(path));
}

describe('findOnPath', () => {
  it('searches POSIX PATH entries in order', async () => {
    await expect(
      findOnPath('claude', {
        platform: 'darwin',
        pathEnv: '/usr/bin::/opt/homebrew/bin:/usr/local/bin',
        pathExt: '',
        exists: existsIn(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
      }),
    ).resolves.toBe('/opt/homebrew/bin/claude');
  });

  it('tries PATHEXT extensions on Windows and skips script shims', async () => {
    const deps = {
      platform: 'win32' as const,
      pathEnv: 'C:\\npm; C:\\bin',
      pathExt: '.COM;.EXE;.BAT;.CMD;.PS1',
    };
    await expect(
      findOnPath('claude', { ...deps, exists: existsIn(['C:\\npm\\claude.cmd', 'C:\\npm\\claude.ps1', 'C:\\bin\\claude.exe']) }),
    ).resolves.toBe('C:\\bin\\claude.exe');
    await expect(findOnPath('claude', { ...deps, exists: existsIn(['C:\\npm\\claude.bat']) })).resolves.toBeNull();
  });

  it('returns null for an empty PATH', async () => {
    await expect(findOnPath('claude', { platform: 'linux', pathEnv: '', pathExt: '', exists: existsIn([]) })).resolves.toBeNull();
  });
});
