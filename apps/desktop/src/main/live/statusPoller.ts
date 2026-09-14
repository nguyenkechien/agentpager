import type { DaemonView } from '../../shared/api.js';

export const STATUS_POLL_INTERVAL_MS = 2_000;

export interface StatusPollerDeps {
  read: () => Promise<DaemonView>;
  /** Called with every view that differs from the previous one (and the first). */
  onChange: (view: DaemonView) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
}

/** Polls the daemon status while the app runs; the tray and the window only hear about changes. */
export class StatusPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<DaemonView> | null = null;
  private lastKey: string | null = null;
  private last: DaemonView | null = null;

  constructor(private readonly deps: StatusPollerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = setInterval(() => {
      this.tick();
    }, this.deps.intervalMs ?? STATUS_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  current(): DaemonView | null {
    return this.last;
  }

  /** Reads now (sharing a read already in progress), e.g. right after Start/Stop. */
  refresh(): Promise<DaemonView> {
    this.inFlight ??= this.deps
      .read()
      .then((view) => {
        const key = JSON.stringify(view);
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.last = view;
          this.deps.onChange(view);
        }
        return view;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private tick(): void {
    // A slow IPC answer must not stack reads: skip this tick instead.
    if (this.inFlight !== null) return;
    this.refresh().catch((error: unknown) => {
      this.deps.onError(error);
    });
  }
}
