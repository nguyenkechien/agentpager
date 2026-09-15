import { describe, expect, it } from 'vitest';
import { createMacReleaseSource, RELEASES_LATEST_URL } from '../../../src/main/update/macReleaseSource.js';
import type { SourceEvent } from '../../../src/main/update/source.js';

const PAGE = 'https://github.com/nguyenkechien/agentpager/releases/tag/v0.1.1';

function release(tag: string, assets: string[] = [], htmlUrl = PAGE): unknown {
  return {
    tag_name: tag,
    html_url: htmlUrl,
    assets: assets.map((name) => ({ name, browser_download_url: `https://github.com/nguyenkechien/agentpager/releases/download/${tag}/${name}` })),
  };
}

async function check(answer: () => Promise<unknown>, currentVersion = '0.1.0', arch = 'arm64'): Promise<{ events: SourceEvent[]; urls: string[] }> {
  const urls: string[] = [];
  const events: SourceEvent[] = [];
  const source = createMacReleaseSource({
    fetchJson: (url) => {
      urls.push(url);
      return answer();
    },
    currentVersion,
    arch,
  });
  source.onEvent((event) => {
    events.push(event);
  });
  await source.check();
  return { events, urls };
}

describe('createMacReleaseSource', () => {
  it('finds the disk image for this architecture in a newer release', async () => {
    const result = await check(() => Promise.resolve(release('v0.1.1', ['agentpager-0.1.1-x64.dmg', 'agentpager-0.1.1-arm64.dmg'])));
    expect(result.urls).toEqual([RELEASES_LATEST_URL]);
    expect(result.events).toEqual([
      { kind: 'checking' },
      {
        kind: 'available',
        version: '0.1.1',
        downloadUrl: 'https://github.com/nguyenkechien/agentpager/releases/download/v0.1.1/agentpager-0.1.1-arm64.dmg',
      },
    ]);
  });

  it('falls back to the release page without a matching disk image', async () => {
    const result = await check(() => Promise.resolve(release('v0.1.1', ['agentpager-0.1.1-arm64.dmg'])), '0.1.0', 'x64');
    expect(result.events.at(-1)).toEqual({ kind: 'available', version: '0.1.1', downloadUrl: PAGE });
  });

  it('reports nothing for the same or an older version', async () => {
    expect((await check(() => Promise.resolve(release('v0.1.0')))).events.at(-1)).toEqual({ kind: 'none' });
    expect((await check(() => Promise.resolve(release('v0.0.9')), '0.1.0')).events.at(-1)).toEqual({ kind: 'none' });
  });

  it('reports odd tags, bad answers, network failures and foreign links as errors', async () => {
    expect((await check(() => Promise.resolve(release('latest')))).events.at(-1)).toEqual({
      kind: 'error',
      message: 'The latest release has an unexpected tag: latest',
    });
    expect((await check(() => Promise.resolve({ message: 'Not Found' }))).events.at(-1)).toMatchObject({ kind: 'error' });
    expect((await check(() => Promise.reject(new Error('GitHub returned 403')))).events.at(-1)).toEqual({
      kind: 'error',
      message: 'Could not check for updates: GitHub returned 403',
    });
    expect((await check(() => Promise.resolve(release('v0.2.0', [], 'https://evil.example/page')))).events.at(-1)).toMatchObject({
      kind: 'error',
    });
  });
});
