import type { DaemonView } from '../../shared/api.js';
import { toApiError } from '../services/results.js';
import type { DesktopLog } from '../shell/desktopLog.js';
import type { ResumeMarkerState } from './resumeMarker.js';

export interface ResumeAfterUpdateDeps {
  consume: () => Promise<ResumeMarkerState>;
  status: () => Promise<DaemonView>;
  start: () => Promise<DaemonView>;
  notify: (title: string, body: string) => void;
  log: DesktopLog;
  /** The version now running. */
  version: string;
}

/** On app start: when an update stopped the bot a moment ago, start it again and say so. */
export async function resumeAfterUpdate(deps: ResumeAfterUpdateDeps): Promise<void> {
  const marker = await deps.consume();
  switch (marker.kind) {
    case 'none':
      return;
    case 'invalid':
      deps.log.info('ignored an unreadable update-resume.json');
      return;
    case 'stale':
      deps.log.info('ignored a stale update-resume.json', { requestedAt: marker.requestedAt });
      return;
    case 'fresh':
      break;
  }

  const title = `Updated agentpager to ${deps.version}`;
  const current = await deps.status();
  if (current.badge !== 'stopped' && current.badge !== 'error') {
    deps.log.info('bot already running after the update', { fromVersion: marker.fromVersion });
    deps.notify(title, 'The bot is running.');
    return;
  }
  try {
    await deps.start();
    deps.log.info('restarted the bot after the update', { fromVersion: marker.fromVersion });
    deps.notify(title, 'The bot is running again.');
  } catch (error) {
    deps.log.error('could not start the bot after the update', error);
    deps.notify(title, `The bot could not restart: ${toApiError(error).message}`);
  }
}
