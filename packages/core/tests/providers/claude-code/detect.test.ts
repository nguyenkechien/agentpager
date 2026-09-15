import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_BINARY_PROBLEM,
  commonClaudePaths,
  detectClaudeCode,
  type DetectDeps,
} from '../../../src/providers/claude-code/detect.js';

function deps(overrides: Partial<DetectDeps> & { files?: string[] }): DetectDeps {
  const files = new Set(overrides.files ?? []);
  return {
    platform: 'win32',
    homedir: 'C:\\Users\\u',
    pathEnv: '',
    pathExt: '.EXE;.CMD',
    exists: (path) => Promise.resolve(files.has(path)),
    runVersion: () => Promise.resolve('2.1.0 (Claude Code)'),
    ...overrides,
  };
}

describe('commonClaudePaths', () => {
  it('lists the native installer location per platform', () => {
    expect(commonClaudePaths('win32', 'C:\\Users\\u')).toEqual(['C:\\Users\\u\\.local\\bin\\claude.exe']);
    expect(commonClaudePaths('darwin', '/Users/u')).toEqual([
      '/Users/u/.local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]);
  });
});

describe('detectClaudeCode', () => {
  it('uses a configured executable that exists', async () => {
    const runVersion = vi.fn(() => Promise.resolve('2.1.0 (Claude Code)'));
    await expect(
      detectClaudeCode({ executable: 'E:\\tools\\claude.exe' }, deps({ files: ['E:\\tools\\claude.exe'], runVersion })),
    ).resolves.toEqual({ executable: 'E:\\tools\\claude.exe', version: '2.1.0 (Claude Code)', problems: [] });
    expect(runVersion).toHaveBeenCalledWith('E:\\tools\\claude.exe');
  });

  it('reports a configured executable that is missing without searching further', async () => {
    const result = await detectClaudeCode(
      { executable: 'E:\\tools\\claude.exe' },
      deps({ files: ['C:\\Users\\u\\.local\\bin\\claude.exe'] }),
    );
    expect(result.executable).toBeNull();
    expect(result.problems).toEqual(['Configured claude file not found: E:\\tools\\claude.exe']);
  });

  it('finds claude on PATH', async () => {
    await expect(
      detectClaudeCode({ executable: null }, deps({ pathEnv: 'C:\\bin;D:\\bin', files: ['D:\\bin\\claude.exe'] })),
    ).resolves.toMatchObject({ executable: 'D:\\bin\\claude.exe', problems: [] });
  });

  it('ignores script shims on PATH and falls back to the common install path', async () => {
    await expect(
      detectClaudeCode(
        { executable: null },
        deps({ pathEnv: 'C:\\npm', files: ['C:\\npm\\claude.cmd', 'C:\\Users\\u\\.local\\bin\\claude.exe'] }),
      ),
    ).resolves.toMatchObject({ executable: 'C:\\Users\\u\\.local\\bin\\claude.exe' });
  });

  it('checks Homebrew on macOS', async () => {
    await expect(
      detectClaudeCode(
        { executable: null },
        deps({ platform: 'darwin', homedir: '/Users/u', pathEnv: '/usr/bin', files: ['/opt/homebrew/bin/claude'] }),
      ),
    ).resolves.toMatchObject({ executable: '/opt/homebrew/bin/claude' });
  });

  it('falls back to the bundled binary when nothing is found', async () => {
    await expect(detectClaudeCode({ executable: null }, deps({}))).resolves.toEqual({
      executable: null,
      version: null,
      problems: [BUNDLED_BINARY_PROBLEM],
    });
  });
});
