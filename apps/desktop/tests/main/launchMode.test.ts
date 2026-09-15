import { describe, expect, it } from 'vitest';
import { parseLaunchMode } from '../../src/main/launchMode.js';

describe('parseLaunchMode', () => {
  it('routes --daemon before anything else, in packaged and dev argv shapes', () => {
    expect(parseLaunchMode(['C:\\agentpager\\agentpager.exe', '--daemon'])).toEqual({ kind: 'daemon' });
    expect(parseLaunchMode(['C:\\electron.exe', 'D:\\Projects\\agentpager\\apps\\desktop', '--daemon'])).toEqual({ kind: 'daemon' });
    expect(parseLaunchMode(['agentpager.exe', '--hidden', '--daemon'])).toEqual({ kind: 'daemon' });
  });

  it('routes the installer maintenance flags, after --daemon', () => {
    expect(parseLaunchMode(['agentpager.exe', '--prepare-update'])).toEqual({ kind: 'maintenance', task: 'prepare-update' });
    expect(parseLaunchMode(['agentpager.exe', '--uninstall-cleanup'])).toEqual({ kind: 'maintenance', task: 'uninstall-cleanup' });
    expect(parseLaunchMode(['agentpager.exe', '--prepare-update', '--daemon'])).toEqual({ kind: 'daemon' });
  });

  it('starts the GUI, hidden only with --hidden', () => {
    expect(parseLaunchMode(['/Applications/agentpager.app/Contents/MacOS/agentpager'])).toEqual({ kind: 'gui', hidden: false });
    expect(parseLaunchMode(['agentpager.exe', '--hidden'])).toEqual({ kind: 'gui', hidden: true });
  });

  it('ignores look-alike arguments', () => {
    expect(parseLaunchMode(['agentpager.exe', '--daemonize', 'daemon', '--hidden=false'])).toEqual({ kind: 'gui', hidden: false });
  });
});
