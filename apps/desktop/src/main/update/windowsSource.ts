import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { DesktopLog } from '../shell/desktopLog.js';
import { messageOf, type InstallingSource, type SourceEvent } from './source.js';

interface UpdaterEvents {
  'checking-for-update': () => void;
  'update-not-available': (info: UpdateInfo) => void;
  'update-available': (info: UpdateInfo) => void;
  'download-progress': (progress: ProgressInfo) => void;
  'update-downloaded': (info: UpdateInfo) => void;
  error: (error: Error) => void;
}

/** The part of electron-updater's `autoUpdater` this source uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: AppUpdater['logger'];
  on: <E extends keyof UpdaterEvents>(event: E, listener: UpdaterEvents[E]) => unknown;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
}

/** GitHub release notes arrive as HTML (string) or, with fullChangelog, as a list. */
export function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | null {
  if (notes === undefined || notes === null) return null;
  const html = typeof notes === 'string' ? notes : notes.map((entry) => entry.note ?? '').join('\n');
  const text = html
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/**
 * electron-updater against the GitHub releases of this repository (app-update.yml, written by electron-builder).
 * Downloads in the background; installing on quit stays off, because quitting the app must never replace files
 * under a running bot.
 */
export function createWindowsSource(updater: UpdaterLike, log: DesktopLog): InstallingSource {
  const listeners: ((event: SourceEvent) => void)[] = [];
  const emit = (event: SourceEvent): void => {
    for (const listener of listeners) listener(event);
  };
  let downloadingVersion: string | null = null;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.logger = {
    info: (message?: unknown) => {
      log.info(`updater: ${String(message)}`);
    },
    warn: (message?: unknown) => {
      log.info(`updater warning: ${String(message)}`);
    },
    error: (message?: unknown) => {
      log.error('updater', message);
    },
  };

  updater.on('checking-for-update', () => {
    emit({ kind: 'checking' });
  });
  updater.on('update-not-available', () => {
    emit({ kind: 'none' });
  });
  updater.on('update-available', (info) => {
    downloadingVersion = info.version;
    emit({ kind: 'downloading', version: info.version, percent: 0 });
  });
  updater.on('download-progress', (progress) => {
    if (downloadingVersion !== null) emit({ kind: 'downloading', version: downloadingVersion, percent: Math.round(progress.percent) });
  });
  updater.on('update-downloaded', (info) => {
    emit({ kind: 'ready', version: info.version, notes: releaseNotesText(info.releaseNotes) });
  });
  updater.on('error', (error) => {
    emit({ kind: 'error', message: messageOf(error) });
  });

  return {
    kind: 'windows',
    onEvent: (listener) => {
      listeners.push(listener);
    },
    check: async () => {
      try {
        await updater.checkForUpdates();
      } catch (error) {
        // electron-updater usually emits 'error' as well; the service shows the same message either way.
        emit({ kind: 'error', message: messageOf(error) });
      }
    },
    install: () => {
      // Silent installer, then start the new version.
      updater.quitAndInstall(true, true);
    },
  };
}
