import { describe, expect, it } from 'vitest';
import { resumeAfterUpdate } from '../../../src/main/maintenance/resumeAfterUpdate.js';
import type { ResumeMarkerState } from '../../../src/main/maintenance/resumeMarker.js';
import { ApiFailure } from '../../../src/main/services/results.js';
import type { BadgeState, DaemonView } from '../../../src/shared/api.js';

function view(badge: BadgeState): DaemonView {
  return {
    badge,
    pid: null,
    startedAt: null,
    workerPid: null,
    restarts: 0,
    botUsername: null,
    provider: null,
    lastError: null,
    launcher: null,
  };
}

interface Run {
  started: number;
  notices: [string, string][];
  infos: string[];
  errors: string[];
}

async function run(marker: ResumeMarkerState, badge: BadgeState, start: () => Promise<DaemonView> = () => Promise.resolve(view('running'))): Promise<Run> {
  const result: Run = { started: 0, notices: [], infos: [], errors: [] };
  await resumeAfterUpdate({
    consume: () => Promise.resolve(marker),
    status: () => Promise.resolve(view(badge)),
    start: () => {
      result.started += 1;
      return start();
    },
    notify: (title, body) => {
      result.notices.push([title, body]);
    },
    log: {
      info: (message) => {
        result.infos.push(message);
      },
      error: (context) => {
        result.errors.push(context);
      },
    },
    version: '0.1.1',
  });
  return result;
}

describe('resumeAfterUpdate', () => {
  it('does nothing without a marker', async () => {
    expect(await run({ kind: 'none' }, 'stopped')).toEqual({ started: 0, notices: [], infos: [], errors: [] });
  });

  it('starts the stopped bot after a fresh update and says so', async () => {
    const result = await run({ kind: 'fresh', fromVersion: '0.1.0' }, 'stopped');
    expect(result.started).toBe(1);
    expect(result.notices).toEqual([['Đã cập nhật agentpager lên 0.1.1', 'Bot đã chạy lại.']]);
  });

  it('does not start a second bot when one already runs', async () => {
    const result = await run({ kind: 'fresh', fromVersion: '0.1.0' }, 'running');
    expect(result.started).toBe(0);
    expect(result.notices).toEqual([['Đã cập nhật agentpager lên 0.1.1', 'Bot đang chạy.']]);
  });

  it('reports a bot that cannot start', async () => {
    const result = await run({ kind: 'fresh', fromVersion: '0.1.0' }, 'error', () =>
      Promise.reject(new ApiFailure({ code: 'fatal', message: 'Token Telegram không hợp lệ' })),
    );
    expect(result.notices).toEqual([['Đã cập nhật agentpager lên 0.1.1', 'Bot chưa chạy lại được: Token Telegram không hợp lệ']]);
    expect(result.errors).toEqual(['could not start the bot after the update']);
  });

  it('only logs stale or unreadable markers', async () => {
    const stale = await run({ kind: 'stale', requestedAt: '2026-09-01T00:00:00.000Z' }, 'stopped');
    expect(stale).toEqual({ started: 0, notices: [], infos: ['ignored a stale update-resume.json'], errors: [] });
    const invalid = await run({ kind: 'invalid' }, 'stopped');
    expect(invalid).toEqual({ started: 0, notices: [], infos: ['ignored an unreadable update-resume.json'], errors: [] });
  });
});
