import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  consumeResumeMarker,
  RESUME_MARKER_FILE,
  RESUME_MARKER_MAX_AGE_MS,
  writeResumeMarker,
} from '../../../src/main/maintenance/resumeMarker.js';

const AT = new Date('2026-09-15T10:00:00.000Z');

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentpager-marker-'));
}

describe('resume marker', () => {
  it('writes the marker and keeps an existing one', async () => {
    const root = join(tempRoot(), 'nested');
    await writeResumeMarker(root, '0.1.0', AT);
    await writeResumeMarker(root, '9.9.9', new Date(AT.getTime() + 1_000));
    expect(JSON.parse(readFileSync(join(root, RESUME_MARKER_FILE), 'utf8'))).toEqual({
      version: 1,
      requestedAt: '2026-09-15T10:00:00.000Z',
      fromVersion: '0.1.0',
    });
  });

  it('reports a fresh marker once and removes it', async () => {
    const root = tempRoot();
    await writeResumeMarker(root, '0.1.0', AT);
    await expect(consumeResumeMarker(root, new Date(AT.getTime() + RESUME_MARKER_MAX_AGE_MS))).resolves.toEqual({
      kind: 'fresh',
      fromVersion: '0.1.0',
    });
    expect(existsSync(join(root, RESUME_MARKER_FILE))).toBe(false);
    await expect(consumeResumeMarker(root, AT)).resolves.toEqual({ kind: 'none' });
  });

  it('treats old or future markers as stale and removes them', async () => {
    const root = tempRoot();
    await writeResumeMarker(root, '0.1.0', AT);
    await expect(consumeResumeMarker(root, new Date(AT.getTime() + RESUME_MARKER_MAX_AGE_MS + 1))).resolves.toEqual({
      kind: 'stale',
      requestedAt: '2026-09-15T10:00:00.000Z',
    });
    await writeResumeMarker(root, '0.1.0', AT);
    await expect(consumeResumeMarker(root, new Date(AT.getTime() - 1))).resolves.toMatchObject({ kind: 'stale' });
    expect(existsSync(join(root, RESUME_MARKER_FILE))).toBe(false);
  });

  it('removes a marker it cannot read', async () => {
    const root = tempRoot();
    writeFileSync(join(root, RESUME_MARKER_FILE), '{ not json', 'utf8');
    await expect(consumeResumeMarker(root, AT)).resolves.toEqual({ kind: 'invalid' });
    writeFileSync(join(root, RESUME_MARKER_FILE), JSON.stringify({ version: 2 }), 'utf8');
    await expect(consumeResumeMarker(root, AT)).resolves.toEqual({ kind: 'invalid' });
    expect(existsSync(join(root, RESUME_MARKER_FILE))).toBe(false);
  });
});
