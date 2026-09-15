import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SourceEvent } from '../../../src/main/update/source.js';
import { createWindowsSource, releaseNotesText, type UpdaterLike } from '../../../src/main/update/windowsSource.js';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  logger: UpdaterLike['logger'] = null;
  installs: [boolean | undefined, boolean | undefined][] = [];
  checkResult: Promise<null> = Promise.resolve(null);

  checkForUpdates(): Promise<null> {
    return this.checkResult;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(): { updater: FakeUpdater; events: SourceEvent[]; source: ReturnType<typeof createWindowsSource> } {
  const updater = new FakeUpdater();
  const events: SourceEvent[] = [];
  const source = createWindowsSource(updater, { info: () => undefined, error: () => undefined });
  source.onEvent((event) => {
    events.push(event);
  });
  return { updater, events, source };
}

describe('createWindowsSource', () => {
  it('downloads automatically but never installs on quit', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.logger).not.toBeNull();
  });

  it('maps updater events', () => {
    const { updater, events } = setup();
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '0.1.1' });
    updater.emit('download-progress', { percent: 41.6 });
    updater.emit('update-downloaded', { version: '0.1.1', releaseNotes: '<p>Fixes &amp; additions</p>' });
    updater.emit('update-not-available', { version: '0.1.0' });
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(events).toEqual([
      { kind: 'checking' },
      { kind: 'downloading', version: '0.1.1', percent: 0 },
      { kind: 'downloading', version: '0.1.1', percent: 42 },
      { kind: 'ready', version: '0.1.1', notes: 'Fixes & additions' },
      { kind: 'none' },
      { kind: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' },
    ]);
  });

  it('reports a failed check as an event instead of rejecting', async () => {
    const { updater, events, source } = setup();
    updater.checkResult = Promise.reject(new Error('Cannot find latest.yml'));
    await expect(source.check()).resolves.toBeUndefined();
    expect(events).toEqual([{ kind: 'error', message: 'Cannot find latest.yml' }]);
  });

  it('installs silently and starts the new version', () => {
    const { updater, source } = setup();
    source.install();
    expect(updater.installs).toEqual([[true, true]]);
  });
});

describe('releaseNotesText', () => {
  it('turns release notes into plain text', () => {
    expect(releaseNotesText(null)).toBeNull();
    expect(releaseNotesText('<h2>0.1.1</h2><ul><li>One</li><li>Two</li></ul>')).toBe('0.1.1\nOne\nTwo');
    expect(releaseNotesText([{ version: '0.1.1', note: 'A' }, { version: '0.1.0', note: null }])).toBe('A');
    expect(releaseNotesText('   ')).toBeNull();
  });
});
