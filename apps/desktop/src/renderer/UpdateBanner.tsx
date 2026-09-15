import { useState, type ReactNode } from 'react';
import type { InstallMode, InstallResult, UpdateView } from '../shared/api.js';
import { api } from './api.js';
import { Banner, Button } from './components.js';
import { plural } from './format.js';
import { useAction } from './hooks.js';

type BusyResult = Extract<InstallResult, { kind: 'busy' } | { kind: 'busy_unknown' }>;

function busyText(result: BusyResult): string {
  if (result.kind === 'busy_unknown') {
    return 'The bot runs an older core that cannot tell whether the agent is busy. Updating now stops any running turn (the session is kept).';
  }
  const parts: string[] = [];
  if (result.activeTurns > 0) parts.push(`is running ${plural(result.activeTurns, 'turn')}`);
  if (result.queuedInputs > 0) parts.push(`has ${plural(result.queuedInputs, 'queued message')}`);
  return `The agent ${parts.join(' and ')}. Updating now stops that work (the session is kept, and you can keep chatting once the bot is back).`;
}

function BusyDialog({ result, onChoose }: { result: BusyResult; onChoose: (choice: InstallMode | 'cancel') => void }) {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="update-busy-title">
      <h2 id="update-busy-title">The agent is busy</h2>
      <p>{busyText(result)}</p>
      <div className="button-row">
        {result.kind === 'busy' ? (
          <Button
            variant="primary"
            autoFocus
            onClick={() => {
              onChoose('when_idle');
            }}
          >
            Update when idle
          </Button>
        ) : null}
        <Button
          variant="danger"
          autoFocus={result.kind === 'busy_unknown'}
          onClick={() => {
            onChoose('now');
          }}
        >
          Update now
        </Button>
        <Button
          onClick={() => {
            onChoose('cancel');
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Shown above every screen while an update is ready, waiting, installing, or (macOS) available to download. */
export function UpdateBanner({ view }: { view: UpdateView | null }) {
  const action = useAction();
  const [busy, setBusy] = useState<BusyResult | null>(null);
  const pending = action.pending !== null;

  const install = async (mode: InstallMode): Promise<void> => {
    setBusy(null);
    const result = await action.run(mode, () => api().update.install(mode));
    if (result?.kind === 'busy' || result?.kind === 'busy_unknown') setBusy(result);
  };

  let banner: ReactNode;
  switch (view?.kind) {
    case 'ready':
      banner = (
        <Banner
          tone="info"
          title={`New version v${view.version}`}
          actions={
            <Button
              variant="primary"
              busy={pending}
              busyLabel="Preparing…"
              onClick={() => {
                void install('ask');
              }}
            >
              Update
            </Button>
          }
        >
          The bot will stop for about half a minute, then start again.
          {view.installError ? <div className="warning-text">⚠️ {view.installError}</div> : null}
        </Banner>
      );
      break;
    case 'available':
      banner = (
        <Banner
          tone="info"
          title={`New version v${view.version}`}
          actions={
            <Button
              variant="primary"
              busy={pending}
              busyLabel="Opening…"
              onClick={() => {
                void action.run('open', () => api().update.openDownload());
              }}
            >
              Download
            </Button>
          }
        >
          Download the .dmg file and drag agentpager to Applications to replace the old version.
        </Banner>
      );
      break;
    case 'waiting_idle':
      banner = (
        <Banner
          tone="info"
          title={`Will update to v${view.version} when the agent is idle`}
          actions={
            <>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => {
                  void install('now');
                }}
              >
                Update now
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  void action.run('cancel', () => api().update.cancelWaiting());
                }}
              >
                Cancel
              </Button>
            </>
          }
        >
          {view.activeTurns > 0 ? `${plural(view.activeTurns, 'turn')} still running` : 'No turns running'}
          {view.queuedInputs > 0 ? `, ${plural(view.queuedInputs, 'queued message')}.` : '.'}
        </Banner>
      );
      break;
    case 'installing':
      banner = (
        <Banner tone="info" title={`Installing v${view.version}…`}>
          agentpager will reopen when the install finishes.
        </Banner>
      );
      break;
    default:
      banner = null;
  }

  return (
    <>
      {banner}
      {busy ? (
        <BusyDialog
          result={busy}
          onChoose={(choice) => {
            if (choice === 'cancel') setBusy(null);
            else void install(choice);
          }}
        />
      ) : null}
      {action.error ? (
        <Banner tone="error" title="Update failed">
          {action.error.message}
        </Banner>
      ) : null}
    </>
  );
}
