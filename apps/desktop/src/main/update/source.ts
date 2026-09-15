/** What an update source reports; the update service turns these into the view the UI shows. */
export type SourceEvent =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string; notes: string | null }
  | { kind: 'available'; version: string; downloadUrl: string }
  | { kind: 'error'; message: string };

interface SourceBase {
  /** Resolves when the check is done; problems are reported as `error` events, never as a rejection. */
  check: () => Promise<void>;
  onEvent: (listener: (event: SourceEvent) => void) => void;
}

/** Windows: downloads the installer itself and runs it. */
export interface InstallingSource extends SourceBase {
  kind: 'windows';
  install: () => void;
}

/** macOS: only finds the newer release; the user downloads it. */
export interface NoticeSource extends SourceBase {
  kind: 'mac';
}

export type UpdateSource = InstallingSource | NoticeSource;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
