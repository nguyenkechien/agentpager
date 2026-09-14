import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stableExecutablePath } from '../../src/platform/realPath.js';

describe('stableExecutablePath', () => {
  it('resolves a per-shell directory junction to the installed executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'ap-realpath-'));
    const installation = join(root, 'node-versions', 'v26.8.2', 'installation');
    mkdirSync(installation, { recursive: true });
    writeFileSync(join(installation, 'node.exe'), '');
    const shellLink = join(root, 'fnm_multishells', '23732_1789375942025');
    mkdirSync(join(root, 'fnm_multishells'));
    // "junction" needs no admin rights on Windows; other platforms create a directory symlink.
    symlinkSync(installation, shellLink, 'junction');

    expect(stableExecutablePath(join(shellLink, 'node.exe'))).toBe(realpathSync(join(installation, 'node.exe')));
  });

  it('keeps a path that is not a link', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ap-realpath-')), 'main.js');
    writeFileSync(file, '');
    expect(stableExecutablePath(file)).toBe(realpathSync(file));
  });
});
