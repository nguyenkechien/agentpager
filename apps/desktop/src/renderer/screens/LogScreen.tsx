import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonView, LogSource } from '../../shared/api.js';
import { api } from '../api.js';
import { Banner, Button } from '../components.js';
import { formatClock } from '../format.js';
import { useAction } from '../hooks.js';
import { appendLogLines, matchesLogFilter, type LevelFilter, type LogEntry } from '../logBuffer.js';

const SOURCES: readonly { id: LogSource; label: string }[] = [
  { id: 'worker', label: 'Bot' },
  { id: 'supervisor', label: 'Supervisor' },
];

const FILTERS: readonly { id: LevelFilter; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warn+' },
  { id: 'error', label: 'Error' },
];

function isLevelFilter(value: string): value is LevelFilter {
  return FILTERS.some((entry) => entry.id === value);
}

/** Hidden windows (closed to the tray, minimised) stop following logs. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = (): void => {
      setVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
    };
  }, []);
  return visible;
}

export function LogScreen({ daemon }: { daemon: DaemonView | null }) {
  const [source, setSource] = useState<LogSource>('worker');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const visible = useDocumentVisible();
  const nextId = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const start = useAction();

  useEffect(() => {
    if (!visible) return;
    // Every subscription starts with the tail again.
    setEntries([]);
    setExpanded(new Set());
    return api().logs.subscribe(source, (lines) => {
      const firstId = nextId.current;
      nextId.current += lines.length;
      setEntries((current) => appendLogLines(current, lines, firstId));
    });
  }, [source, visible]);

  useEffect(() => {
    const list = listRef.current;
    if (!paused && list) list.scrollTop = list.scrollHeight;
  }, [entries, paused]);

  const shown = useMemo(() => entries.filter((entry) => matchesLogFilter(entry, filter, search)), [entries, filter, search]);
  const nothingRuns = daemon !== null && (daemon.badge === 'stopped' || daemon.badge === 'error');

  const toggleExtra = (id: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="screen screen-log" aria-labelledby="log-title">
      <header className="screen-header">
        <h1 id="log-title">Log</h1>
        <div className="tabs" role="tablist" aria-label="Nguồn log">
          {SOURCES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={source === entry.id}
              onClick={() => {
                setSource(entry.id);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <div className="toolbar">
        <label>
          Mức
          <select
            value={filter}
            onChange={(event) => {
              if (isLevelFilter(event.target.value)) setFilter(event.target.value);
            }}
          >
            {FILTERS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tìm
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>
        <Button
          aria-pressed={paused}
          onClick={() => {
            setPaused((current) => !current);
          }}
        >
          {paused ? 'Tiếp tục cuộn' : 'Tạm dừng cuộn'}
        </Button>
        <Button
          onClick={() => {
            void api().shell.openLogFolder();
          }}
        >
          Mở thư mục log
        </Button>
      </div>

      {start.error ? <Banner tone="error">{start.error.message}</Banner> : null}

      {entries.length === 0 ? (
        <div className="empty">
          <p>Chưa có log</p>
          {nothingRuns ? (
            <Button
              variant="primary"
              busy={start.pending !== null}
              busyLabel="Đang khởi động…"
              onClick={() => {
                void start.run('start', () => api().daemon.start());
              }}
            >
              Start
            </Button>
          ) : null}
        </div>
      ) : shown.length === 0 ? (
        <p className="muted">Không có dòng nào khớp bộ lọc.</p>
      ) : (
        <ol className="log-lines" ref={listRef} aria-label="Dòng log">
          {shown.map((entry) => (
            <li key={entry.id} className={`log-line level-${entry.level ?? 'plain'}`}>
              <span className="log-time">{entry.time === null ? '--:--:--' : formatClock(entry.time)}</span>
              <span className="log-level">{entry.level?.toUpperCase() ?? ''}</span>
              <span className="log-message">{entry.message}</span>
              {entry.extra ? (
                <button
                  type="button"
                  className="log-extra-toggle"
                  aria-expanded={expanded.has(entry.id)}
                  onClick={() => {
                    toggleExtra(entry.id);
                  }}
                >
                  {expanded.has(entry.id) ? 'Ẩn chi tiết' : 'Chi tiết'}
                </button>
              ) : null}
              {entry.extra && expanded.has(entry.id) ? <pre className="log-extra">{JSON.stringify(entry.extra, null, 2)}</pre> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
