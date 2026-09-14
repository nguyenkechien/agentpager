import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureFolderNotInUse, RELEASE_IN_USE_MESSAGE } from '../../scripts/ensureReleaseFree.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe('ensureFolderNotInUse', () => {
  it('leaves a free folder where it was', () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'ap-release-')), 'win-unpacked');
    mkdirSync(folder);
    writeFileSync(join(folder, 'agentpager.exe'), 'binary');
    ensureFolderNotInUse(folder);
    expect(existsSync(join(folder, 'agentpager.exe'))).toBe(true);
    expect(existsSync(`${folder}.in-use-check`)).toBe(false);
  });

  it('does nothing when there is no build yet', () => {
    const renames: string[] = [];
    ensureFolderNotInUse('C:\\nothing\\win-unpacked', (from) => renames.push(from), () => false);
    expect(renames).toEqual([]);
  });

  it('refuses when a running process keeps the folder busy', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      expect(() => {
        ensureFolderNotInUse(
          'C:\\release\\win-unpacked',
          () => {
            throw errno(code);
          },
          () => true,
        );
      }).toThrow(RELEASE_IN_USE_MESSAGE);
    }
  });

  it('passes other rename failures through', () => {
    expect(() => {
      ensureFolderNotInUse(
        'C:\\release\\win-unpacked',
        () => {
          throw errno('ENOSPC');
        },
        () => true,
      );
    }).toThrow('ENOSPC');
  });
});
