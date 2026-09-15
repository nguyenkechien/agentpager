import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_IN_USE_MESSAGE =
  'agentpager is running from the release folder (the app or the bot with --daemon). Stop the bot and quit the app before packing — electron-builder would leave this folder half-deleted.';

/**
 * electron-builder deletes the unpacked output file by file; with the app or its daemon running from it, it fails
 * half way and leaves a broken build behind. Renaming the folder fails on Windows while any file in it is in use,
 * so a rename-and-back proves nothing runs from it before anything is deleted.
 */
export function ensureFolderNotInUse(folder: string, rename: (from: string, to: string) => void = renameSync, exists: (path: string) => boolean = existsSync): void {
  if (!exists(folder)) return;
  const probe = `${folder}.in-use-check`;
  try {
    rename(folder, probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') throw new Error(`${RELEASE_IN_USE_MESSAGE} (${folder})`, { cause: error });
    throw error;
  }
  rename(probe, folder);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (invokedDirectly) {
  const releaseDir = join(import.meta.dirname, '..', 'release');
  try {
    for (const folder of ['win-unpacked', 'win-arm64-unpacked']) ensureFolderNotInUse(join(releaseDir, folder));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
