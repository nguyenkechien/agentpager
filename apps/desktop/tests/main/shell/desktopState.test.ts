import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_STATE_FILE, readDesktopState, updateDesktopState } from '../../../src/main/shell/desktopState.js';

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentpager-desktop-state-')), 'nested', DESKTOP_STATE_FILE);
}

describe('desktop state', () => {
  it('reads a missing file as empty and merges updates', () => {
    const path = file();
    expect(readDesktopState(path)).toEqual({});
    updateDesktopState(path, { trayNoticeShownAt: '2026-09-15T10:00:00.000Z' });
    updateDesktopState(path, { declinedMovePath: '/Users/alex/Downloads/agentpager.app/Contents/MacOS/agentpager' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      trayNoticeShownAt: '2026-09-15T10:00:00.000Z',
      declinedMovePath: '/Users/alex/Downloads/agentpager.app/Contents/MacOS/agentpager',
    });
  });

  it('treats an unreadable file as empty', () => {
    const path = file();
    updateDesktopState(path, {});
    writeFileSync(path, '{ broken', 'utf8');
    expect(readDesktopState(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ trayNoticeShownAt: 5 }), 'utf8');
    expect(readDesktopState(path)).toEqual({});
  });
});
