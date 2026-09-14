import { useEffect, useState } from 'react';
import { Badge, Banner } from './components.js';
import { useConfig, useDaemon } from './hooks.js';
import { LogScreen } from './screens/LogScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { StatusScreen } from './screens/StatusScreen.js';
import { UsersScreen } from './screens/UsersScreen.js';
import { Wizard } from './screens/wizard/Wizard.js';
import { SCREENS, type ScreenId } from './screens.js';

export function App() {
  const config = useConfig();
  const daemon = useDaemon();
  const [screen, setScreen] = useState<ScreenId>('status');
  /** Set while a wizard runs; it outlives the config becoming valid so the pairing step can finish. */
  const [wizard, setWizard] = useState<{ overwrite: boolean } | null>(null);
  const configState = config.view?.state ?? null;

  useEffect(() => {
    if (configState === 'missing') setWizard((current) => current ?? { overwrite: false });
  }, [configState]);

  if (config.view === null) {
    return (
      <main className="loading">
        {config.error ? (
          <Banner tone="error" title="Không đọc được cấu hình">
            {config.error.message}
          </Banner>
        ) : (
          <p role="status">Đang tải…</p>
        )}
      </main>
    );
  }

  if (wizard !== null || config.view.state === 'missing') {
    return (
      <Wizard
        overwrite={wizard?.overwrite ?? false}
        onDone={() => {
          void config.reload().then(() => {
            setWizard(null);
            setScreen('status');
          });
        }}
      />
    );
  }

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Điều hướng">
        <div className="brand">agentpager</div>
        <Badge state={daemon.view?.badge ?? null} />
        <ul>
          {SCREENS.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                aria-current={screen === entry.id ? 'page' : undefined}
                onClick={() => {
                  setScreen(entry.id);
                }}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        {daemon.error ? <Banner tone="error">{daemon.error.message}</Banner> : null}
        {screen === 'status' ? <StatusScreen daemon={daemon.view} config={config.view} onNavigate={setScreen} /> : null}
        {screen === 'users' ? <UsersScreen config={config.view} /> : null}
        {screen === 'settings' ? (
          <SettingsScreen
            config={config.view}
            daemon={daemon.view}
            onRunWizard={() => {
              setWizard({ overwrite: true });
            }}
          />
        ) : null}
        {screen === 'logs' ? <LogScreen daemon={daemon.view} /> : null}
      </main>
    </div>
  );
}
