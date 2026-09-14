import { posix, win32 } from 'node:path';

/** Script shims cannot be spawned directly by the agent SDKs, so they are never returned. */
const WINDOWS_SHIMS = new Set(['.cmd', '.bat', '.ps1']);

export interface FindOnPathDeps {
  platform: NodeJS.Platform;
  pathEnv: string;
  pathExt: string;
  exists(path: string): Promise<boolean>;
}

export async function findOnPath(name: string, deps: FindOnPathDeps): Promise<string | null> {
  const isWindows = deps.platform === 'win32';
  const pathApi = isWindows ? win32 : posix;
  const directories = deps.pathEnv
    .split(isWindows ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const extensions = isWindows
    ? deps.pathExt
        .split(';')
        .map((extension) => extension.trim().toLowerCase())
        .filter((extension) => extension.length > 0 && !WINDOWS_SHIMS.has(extension))
    : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`);
      if (await deps.exists(candidate)) return candidate;
    }
  }
  return null;
}
