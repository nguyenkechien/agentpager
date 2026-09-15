import { useState, type ReactNode } from 'react';
import type { InstallMode, InstallResult, UpdateView } from '../shared/api.js';
import { api } from './api.js';
import { Banner, Button } from './components.js';
import { useAction } from './hooks.js';

type BusyResult = Extract<InstallResult, { kind: 'busy' } | { kind: 'busy_unknown' }>;

function busyText(result: BusyResult): string {
  if (result.kind === 'busy_unknown') {
    return 'Bot đang chạy bằng bản core cũ nên không biết agent có đang bận không. Cập nhật ngay sẽ dừng lượt đang chạy nếu có (session vẫn giữ).';
  }
  const parts: string[] = [];
  if (result.activeTurns > 0) parts.push(`đang chạy ${String(result.activeTurns)} lượt`);
  if (result.queuedInputs > 0) parts.push(`còn ${String(result.queuedInputs)} tin chờ`);
  return `Agent ${parts.join(' và ')}. Cập nhật ngay sẽ dừng lượt đó (session vẫn giữ, nhắn tiếp được sau khi bot chạy lại).`;
}

function BusyDialog({ result, onChoose }: { result: BusyResult; onChoose: (choice: InstallMode | 'cancel') => void }) {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="update-busy-title">
      <h2 id="update-busy-title">Agent đang bận</h2>
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
            Cập nhật khi rảnh
          </Button>
        ) : null}
        <Button
          variant="danger"
          autoFocus={result.kind === 'busy_unknown'}
          onClick={() => {
            onChoose('now');
          }}
        >
          Cập nhật ngay
        </Button>
        <Button
          onClick={() => {
            onChoose('cancel');
          }}
        >
          Huỷ
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
          title={`Có bản mới v${view.version}`}
          actions={
            <Button
              variant="primary"
              busy={pending}
              busyLabel="Đang chuẩn bị…"
              onClick={() => {
                void install('ask');
              }}
            >
              Cập nhật
            </Button>
          }
        >
          Bot sẽ dừng khoảng nửa phút rồi chạy lại.
          {view.installError ? <div className="warning-text">⚠️ {view.installError}</div> : null}
        </Banner>
      );
      break;
    case 'available':
      banner = (
        <Banner
          tone="info"
          title={`Có bản mới v${view.version}`}
          actions={
            <Button
              variant="primary"
              busy={pending}
              busyLabel="Đang mở…"
              onClick={() => {
                void action.run('open', () => api().update.openDownload());
              }}
            >
              Tải bản mới
            </Button>
          }
        >
          Tải file .dmg rồi kéo agentpager vào Applications để thay bản cũ.
        </Banner>
      );
      break;
    case 'waiting_idle':
      banner = (
        <Banner
          tone="info"
          title={`Sẽ cập nhật lên v${view.version} khi agent rảnh`}
          actions={
            <>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => {
                  void install('now');
                }}
              >
                Cập nhật ngay
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  void action.run('cancel', () => api().update.cancelWaiting());
                }}
              >
                Huỷ
              </Button>
            </>
          }
        >
          {view.activeTurns > 0 ? `Còn ${String(view.activeTurns)} lượt đang chạy` : 'Không còn lượt đang chạy'}
          {view.queuedInputs > 0 ? `, ${String(view.queuedInputs)} tin chờ.` : '.'}
        </Banner>
      );
      break;
    case 'installing':
      banner = (
        <Banner tone="info" title={`Đang cài bản mới v${view.version}…`}>
          agentpager sẽ tự mở lại khi cài xong.
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
        <Banner tone="error" title="Cập nhật không thành công">
          {action.error.message}
        </Banner>
      ) : null}
    </>
  );
}
