import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/** App-data file for the app's own small memories (not the bot's). */
export const DESKTOP_STATE_FILE = 'desktop.json';

const stateSchema = z.object({
  /** The "still running in the tray" notice was shown. */
  trayNoticeShownAt: z.string().optional(),
  /** macOS: the user chose "Để sau" when asked to move the app from this executable path to Applications. */
  declinedMovePath: z.string().optional(),
});

export type DesktopState = z.infer<typeof stateSchema>;

/** A missing or unreadable file is an empty state: these are conveniences, never worth failing for. */
export function readDesktopState(file: string): DesktopState {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    return stateSchema.parse(JSON.parse(text));
  } catch {
    return {};
  }
}

export function updateDesktopState(file: string, patch: DesktopState): void {
  const next = { ...readDesktopState(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next)}\n`, 'utf8');
}
