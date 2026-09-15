import semver from 'semver';
import { z } from 'zod';
import { messageOf, type NoticeSource, type SourceEvent } from './source.js';

export const RELEASES_LATEST_URL = 'https://api.github.com/repos/nguyenkechien/agentpager/releases/latest';
/** Only pages of this repository are ever opened from an update notice. */
export const DOWNLOAD_URL_PREFIX = 'https://github.com/nguyenkechien/agentpager/';

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

export interface MacReleaseSourceDeps {
  /** GET a JSON document; rejects on network errors and non-2xx answers. */
  fetchJson: (url: string) => Promise<unknown>;
  currentVersion: string;
  /** `process.arch`: picks the matching disk image. */
  arch: string;
}

/** macOS cannot update itself without a Developer ID: look for a newer published release and point to it. */
export function createMacReleaseSource(deps: MacReleaseSourceDeps): NoticeSource {
  const listeners: ((event: SourceEvent) => void)[] = [];
  const emit = (event: SourceEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const find = async (): Promise<SourceEvent> => {
    let release: z.infer<typeof releaseSchema>;
    try {
      release = releaseSchema.parse(await deps.fetchJson(RELEASES_LATEST_URL));
    } catch (error) {
      return { kind: 'error', message: `Không kiểm tra được bản mới: ${messageOf(error)}` };
    }
    const version = release.tag_name.replace(/^v/, '');
    if (semver.valid(version) === null) return { kind: 'error', message: `Bản phát hành mới nhất có tag lạ: ${release.tag_name}` };
    if (!semver.gt(version, deps.currentVersion)) return { kind: 'none' };
    const asset = release.assets.find((candidate) => candidate.name === `agentpager-${version}-${deps.arch}.dmg`);
    const downloadUrl = asset?.browser_download_url ?? release.html_url;
    if (!downloadUrl.startsWith(DOWNLOAD_URL_PREFIX)) return { kind: 'error', message: `Link tải không thuộc repo agentpager: ${downloadUrl}` };
    return { kind: 'available', version, downloadUrl };
  };

  return {
    kind: 'mac',
    onEvent: (listener) => {
      listeners.push(listener);
    },
    check: async () => {
      emit({ kind: 'checking' });
      emit(await find());
    },
  };
}
