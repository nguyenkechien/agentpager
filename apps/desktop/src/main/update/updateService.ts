import { STOP_TIMEOUT_MS, type StopResult } from '@chiennguyen/agentpager/control';
import type { DaemonInfo, SupervisorStatus } from '@chiennguyen/agentpager/daemon';
import type { InstallMode, InstallResult, UpdateView } from '../../shared/api.js';
import { ApiFailure, toApiError } from '../services/results.js';
import type { DesktopLog } from '../shell/desktopLog.js';
import { DOWNLOAD_URL_PREFIX } from './macReleaseSource.js';
import type { SourceEvent, UpdateSource } from './source.js';

export interface UpdateServiceDeps {
  /** Null when updates are off (development build or AGENTPAGER_HOME); `disabledReason` says why. */
  source: UpdateSource | null;
  disabledReason: 'development' | 'home_override';
  currentVersion: string;
  readDaemon: () => Promise<{ info: DaemonInfo | null; status: SupervisorStatus | null }>;
  /** The daemon runs from this installation, so installing replaces its files. */
  ownsDaemon: (info: DaemonInfo | null) => boolean;
  stopDaemon: () => Promise<StopResult>;
  writeMarker: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  now: () => Date;
  log: DesktopLog;
}

type Ready = Extract<UpdateView, { kind: 'ready' }>;

/** Update state for the window and the tray, and the one place that decides when the bot may be stopped. */
export class UpdateService {
  private state: UpdateView;
  private readonly listeners: ((view: UpdateView) => void)[] = [];
  private checking: Promise<UpdateView> | null = null;
  private checkedAt: string | null = null;
  /** The downloaded update, kept while waiting or installing so a failure can return to it. */
  private ready: Ready | null = null;
  private idleCheck: Promise<void> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    const currentVersion = deps.currentVersion;
    if (deps.source === null) {
      this.state = { kind: 'disabled', currentVersion, reason: deps.disabledReason };
      return;
    }
    this.state = { kind: 'idle', currentVersion, checkedAt: null };
    deps.source.onEvent((event) => {
      this.onSourceEvent(event);
    });
  }

  view(): UpdateView {
    return this.state;
  }

  onChange(listener: (view: UpdateView) => void): void {
    this.listeners.push(listener);
  }

  /** Looks for a newer version; a check in progress is shared, and nothing is checked once an update is ready. */
  check(): Promise<UpdateView> {
    const source = this.deps.source;
    if (source === null || !this.canCheck()) return Promise.resolve(this.state);
    this.checking ??= source
      .check()
      .then(() => this.state)
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  async install(mode: InstallMode): Promise<InstallResult> {
    if (this.state.kind === 'available') return this.openDownload();
    const ready = this.ready;
    if (ready === null || (this.state.kind !== 'ready' && this.state.kind !== 'waiting_idle')) {
      throw new ApiFailure({ code: 'invalid_input', message: 'Chưa có bản cập nhật tải xong để cài.' });
    }
    const { info, status } = await this.deps.readDaemon();
    const owns = status !== null && this.deps.ownsDaemon(info);
    if (owns && mode !== 'now') {
      if (status.activeTurns === null || status.queuedInputs === null) {
        if (mode === 'ask') return { kind: 'busy_unknown' };
        throw new ApiFailure({ code: 'invalid_input', message: 'Bot chạy bằng bản core cũ nên không biết khi nào rảnh — chọn "Cập nhật ngay".' });
      }
      if (status.activeTurns > 0 || status.queuedInputs > 0) {
        if (mode === 'ask') return { kind: 'busy', activeTurns: status.activeTurns, queuedInputs: status.queuedInputs };
        this.setState({
          kind: 'waiting_idle',
          currentVersion: this.deps.currentVersion,
          version: ready.version,
          activeTurns: status.activeTurns,
          queuedInputs: status.queuedInputs,
        });
        return { kind: 'waiting' };
      }
    }
    await this.proceed(ready, owns);
    return { kind: 'installing' };
  }

  /** Called on every daemon status change: an update waiting for the agent installs once it is idle. */
  onDaemonStatus(): void {
    if (this.state.kind !== 'waiting_idle' || this.idleCheck !== null) return;
    this.idleCheck = this.checkIdle()
      .catch((error: unknown) => {
        this.deps.log.error('installing the waiting update failed', error);
      })
      .finally(() => {
        this.idleCheck = null;
      });
  }

  cancelWaiting(): UpdateView {
    if (this.state.kind === 'waiting_idle' && this.ready !== null) this.setState(this.ready);
    return this.state;
  }

  async openDownload(): Promise<InstallResult> {
    const state = this.state;
    if (state.kind !== 'available') throw new ApiFailure({ code: 'invalid_input', message: 'Không có bản mới để tải.' });
    if (!state.downloadUrl.startsWith(DOWNLOAD_URL_PREFIX)) {
      throw new ApiFailure({ code: 'invalid_input', message: `Link tải không thuộc repo agentpager: ${state.downloadUrl}` });
    }
    await this.deps.openExternal(state.downloadUrl);
    return { kind: 'opened' };
  }

  private canCheck(): boolean {
    const kind = this.state.kind;
    return kind !== 'ready' && kind !== 'waiting_idle' && kind !== 'installing' && kind !== 'downloading';
  }

  private async checkIdle(): Promise<void> {
    const ready = this.ready;
    if (ready === null) return;
    const { info, status } = await this.deps.readDaemon();
    if (this.state.kind !== 'waiting_idle') return;
    const owns = status !== null && this.deps.ownsDaemon(info);
    if (owns && status.activeTurns !== null && status.queuedInputs !== null && (status.activeTurns > 0 || status.queuedInputs > 0)) {
      if (status.activeTurns !== this.state.activeTurns || status.queuedInputs !== this.state.queuedInputs) {
        this.setState({ ...this.state, activeTurns: status.activeTurns, queuedInputs: status.queuedInputs });
      }
      return;
    }
    try {
      await this.proceed(ready, owns);
    } catch (error) {
      // proceed() already returned to `ready` with the error shown.
      this.deps.log.error('update after waiting for the agent failed', error);
    }
  }

  private async proceed(ready: Ready, ownsRunningDaemon: boolean): Promise<void> {
    const source = this.deps.source;
    if (source?.kind !== 'windows') throw new ApiFailure({ code: 'invalid_input', message: 'Bản này không tự cài được cập nhật.' });
    this.setState({ kind: 'installing', currentVersion: this.deps.currentVersion, version: ready.version });
    try {
      if (ownsRunningDaemon) {
        await this.deps.writeMarker();
        const stopped = await this.deps.stopDaemon();
        if (stopped.kind === 'timeout') {
          throw new ApiFailure({ code: 'timeout', message: `Bot chưa dừng sau ${STOP_TIMEOUT_MS / 1000} giây nên chưa cài bản mới.` });
        }
      }
    } catch (error) {
      const failed: Ready = { ...ready, installError: toApiError(error).message };
      this.ready = failed;
      this.setState(failed);
      throw error;
    }
    this.deps.log.info('installing update', { version: ready.version, stoppedBot: ownsRunningDaemon });
    source.install();
  }

  private onSourceEvent(event: SourceEvent): void {
    // Once an update is downloaded, the service owns the state until it is installed.
    if (this.ready !== null) return;
    const currentVersion = this.deps.currentVersion;
    const now = this.deps.now().toISOString();
    switch (event.kind) {
      case 'checking':
        this.setState({ kind: 'checking', currentVersion, checkedAt: this.checkedAt });
        return;
      case 'none':
        this.checkedAt = now;
        this.setState({ kind: 'idle', currentVersion, checkedAt: now });
        return;
      case 'downloading':
        this.setState({ kind: 'downloading', currentVersion, version: event.version, percent: event.percent });
        return;
      case 'ready':
        this.checkedAt = now;
        this.ready = { kind: 'ready', currentVersion, version: event.version, notes: event.notes, installError: null };
        this.setState(this.ready);
        return;
      case 'available':
        this.checkedAt = now;
        this.setState({ kind: 'available', currentVersion, version: event.version, downloadUrl: event.downloadUrl, checkedAt: now });
        return;
      case 'error':
        this.setState({ kind: 'error', currentVersion, message: event.message, checkedAt: this.checkedAt });
        return;
    }
  }

  private setState(next: UpdateView): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
