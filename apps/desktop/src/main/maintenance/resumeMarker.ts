import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** App-data file telling the next app start that an update stopped the bot and it should run again. */
export const RESUME_MARKER_FILE = 'update-resume.json';
/** An install takes seconds; a marker older than this was left behind (failed install) and must not start the bot. */
export const RESUME_MARKER_MAX_AGE_MS = 30 * 60_000;

const markerSchema = z.object({ version: z.literal(1), requestedAt: z.string(), fromVersion: z.string() });

export type ResumeMarkerState =
  | { kind: 'none' }
  | { kind: 'fresh'; fromVersion: string }
  | { kind: 'stale'; requestedAt: string }
  | { kind: 'invalid' };

/** Creates the marker unless one exists: the app writes it before the installer's own maintenance step runs. */
export async function writeResumeMarker(root: string, fromVersion: string, now: Date): Promise<void> {
  await mkdir(root, { recursive: true });
  const marker = { version: 1, requestedAt: now.toISOString(), fromVersion };
  try {
    await writeFile(join(root, RESUME_MARKER_FILE), `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Reads and always removes the marker, so it acts at most once. */
export async function consumeResumeMarker(root: string, now: Date, maxAgeMs: number = RESUME_MARKER_MAX_AGE_MS): Promise<ResumeMarkerState> {
  const path = join(root, RESUME_MARKER_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  await rm(path, { force: true });
  let parsed: z.infer<typeof markerSchema>;
  try {
    parsed = markerSchema.parse(JSON.parse(text));
  } catch {
    return { kind: 'invalid' };
  }
  const ageMs = now.getTime() - Date.parse(parsed.requestedAt);
  if (!(ageMs >= 0 && ageMs <= maxAgeMs)) return { kind: 'stale', requestedAt: parsed.requestedAt };
  return { kind: 'fresh', fromVersion: parsed.fromVersion };
}
