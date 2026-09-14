import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corePackageRoot, daemonCommand } from '../../src/main/daemonProcess.js';

describe('daemonCommand', () => {
  it('runs the packaged executable with --daemon', () => {
    expect(
      daemonCommand({ execPath: 'C:\\agentpager\\agentpager.exe', isPackaged: true, appPath: 'C:\\agentpager\\resources\\app.asar' }),
    ).toEqual({ command: 'C:\\agentpager\\agentpager.exe', args: ['--daemon'] });
  });

  it('passes the app folder to the electron binary in development', () => {
    expect(
      daemonCommand({ execPath: 'D:\\node_modules\\electron\\dist\\electron.exe', isPackaged: false, appPath: 'D:\\apps\\desktop' }),
    ).toEqual({ command: 'D:\\node_modules\\electron\\dist\\electron.exe', args: ['D:\\apps\\desktop', '--daemon'] });
  });
});

describe('corePackageRoot', () => {
  it('finds the installed core package with its default guard rules', () => {
    expect(existsSync(join(corePackageRoot(), 'guard-rules.default.json'))).toBe(true);
  });
});
