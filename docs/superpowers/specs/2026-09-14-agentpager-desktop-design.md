# agentpager desktop app (sub-project B) — Design Spec

Date: 2026-09-14
Status: Design approved in chat section by section; written spec pending user review
Builds on: `2026-09-14-agentpager-core-design.md` (sub-project A, released as `@chiennguyen/agentpager` 0.1.1).

## 1. Context and goal

agentpager already runs as a background daemon controlled by the `agentpager` CLI (npm). Sub-project B adds a
desktop app for Windows and macOS so the bot can be set up, started, watched and configured without a
terminal and without installing Node. Sub-project C (installers, signing, auto-update) packages this app.

## 2. Decisions (from the user)

| # | Decision |
|---|---|
| B1 | The app is **self-contained**: it ships its own copy of the agentpager core and runs the bot with Electron's bundled Node. No separate Node/npm install. The npm package keeps working on its own. |
| B2 | The app lives in the **system tray / macOS menu bar with a window**. Closing the window hides it; the bot keeps running even when the app quits. |
| B3 | First run without a config opens a **step-by-step wizard** (same flow as `agentpager setup`). |
| B4 | The main window has four sections: **Status** (status + Start/Stop/Restart), **Users**, **Settings**, **Log**. |
| B5 | Architecture **A — monorepo**: `packages/core` (today's code, still the npm package) + `apps/desktop` (Electron app) calling the core directly. |

Non-goals for B: installers (.exe NSIS, .dmg), code signing, macOS notarization, auto-update (all C); Linux
support; other agent providers; a Telegram chat UI inside the app; languages other than Vietnamese.

## 3. Facts the design relies on (checked 2026-09-14)

- Electron 44.3.0 (latest stable) bundles Node 24.20.0 and Chrome 152, which satisfies the core's
  `engines.node >=22` and ESM. Tooling: electron-vite 5.0.0, electron-builder 26.15.3.
- The Claude Agent SDK starts Claude Code as a native executable (`pathToClaudeCodeExecutable`, or the
  platform binary shipped with the SDK). It only needs a JS runtime (`node` on PATH) when `executable` is set,
  which agentpager does not do.
- The core uses the running Node's path in two places: `runDaemon` forks the worker (`child_process.fork`,
  defaulting to `process.execPath`) and the CLI records `process.execPath` as the autostart node path.

## 4. Repository layout (npm workspaces)

```
package.json              workspace root, private: shared scripts (check, build), eslint + tsconfig base
packages/core/            today's src/, tests/, guard-rules.default.json, README (npm), LICENSE
                          name @chiennguyen/agentpager, bin `agentpager`, published with `npm publish -w packages/core`
apps/desktop/             private Electron app, own version (starts at 0.1.0)
  src/main/               main process: windows, tray, IPC handlers, controller over the core
  src/preload/            contextBridge exposing `window.agentpager`
  src/renderer/           React + TypeScript UI (Vite)
  src/shared/             API types shared by main, preload and renderer
```

The move is a `git mv` of `src/`, `tests/` and `guard-rules.default.json` into `packages/core/`. The user's
global npm install and running bot are unaffected (they run from the npm install, not the repository).

## 5. Core changes

1. **`packages/core/src/control/`** — logic both the CLI and the app need, moved out of `src/cli/`:
   daemon status, start (spawn + wait for ready or fatal), stop (wait for exit), restart (wait for a new worker),
   users-changed notification (`reload-users`), log tail/follow/format and `lastDaemonFatal`. The functions take
   explicit dependencies (IPC, spawn, clock, sleep, log paths) and return results instead of printing; the CLI
   keeps only argument parsing and terminal output.
2. **Generic launch target.** `AutostartTarget` becomes
   `{ command: string; args: string[]; workingDir: string; console: boolean }`.
   The CLI registers `{ command: <node>, args: [<cli main.js>, 'daemon'], console: true }`; the app registers
   `{ command: <agentpager executable>, args: ['--daemon'], console: false }`. On Windows a `console: true` target
   is wrapped in `conhost.exe --headless` (no window from a console program); a `console: false` target (the
   Electron executable, a GUI-subsystem program) is the task action itself. macOS ignores `console`.
   Status parsing (`parseWindowsTaskArguments`, `parseLaunchAgentPlist`) round-trips both shapes.
3. **`daemon.json` `launcher`** — optional `launcher: { kind: 'cli' | 'app'; executable: string }` written by
   `runDaemon` (passed in `RunDaemonOptions`). Optional so files written by 0.1.1 daemons still parse.
4. **`package.json` `exports`** for the entry points the app imports: `./config`, `./control`, `./daemon`,
   `./platform`, `./providers`. No deep imports from the app.

## 6. Processes

| Process | Started by | Does |
|---|---|---|
| App (GUI) | user / login item | tray, window, config edits, IPC client of the daemon; never runs the bot |
| Daemon | app (`<exe> --daemon`, detached, hidden), CLI, or autostart | core `runDaemon`: IPC server, `daemon.json`, supervisor |
| Worker | daemon (`fork`) | Telegram bot + provider, unchanged |

The app's main entry checks `process.argv` for `--daemon` before any window, tray or single-instance lock:
it calls `runDaemon({ paths, platform, packageRoot, foreground: false, launcher: { kind: 'app', executable } })`
and exits with its code. On macOS the daemon process calls `app.dock.hide()`.

## 7. Screens

All text Vietnamese; light/dark follows the system. Main window: left sidebar with **Status · Users ·
Settings · Log**.

### 7.1 Wizard (no `config.json`)

One step per screen with Back/Next:
1. **Bot token** — hidden input, "Check" calls Telegram `getMe` and shows `✅ @botname`; network failure and
   an invalid token have different messages ("Could not connect to Telegram" / "Invalid token"). Offline,
   the user may continue after confirming.
2. **Username** — chips; each entry normalised and validated with `normalizeUsername`.
3. **Projects folder** — default `D:\Projects` (Windows) or `~/Projects` (macOS) when it exists, else the home
   folder; "Choose…" opens the system folder picker; must exist.
4. **Agent** — Claude Code; detection result (path + version, or the bundled-binary warning); "Choose file…".
5. **Session idle timeout** — minutes, default 60, integer ≥ 1.
6. **Finish** — toggles, both on: "Start the bot at login" and "Show tray icon at login";
   button "Save & start bot" writes the config, applies the toggles and starts the daemon.
7. **Pair accounts** — "Send any message to @bot from each account below."; each username flips to "✅ paired" when
   `config.json` shows its `userId` (config change events, section 8.3). "Done" opens the main window.

### 7.2 Status

- Badge: Running / Starting / Restarting / Stopped / Error / Bot not responding / Disconnected.
- Details: `@bot`, daemon pid, uptime, restarts, last error, Claude CLI path + version, launcher
  ("agentpager app" / "agentpager cli").
- Buttons Start / Stop / Restart with progress while waiting; Start is disabled while any daemon runs.
- Toggle "Start the bot at login"; warnings for missing target paths ("Fix autostart") and for a
  target that belongs to the other install ("Switch autostart to this app").

### 7.3 Users

List of `@username` with "paired" (and date) or "waiting to pair". Add (validated), Remove (confirm; the last user cannot
be removed — the core rejects it), Unpair. A running bot is told with `reload-users`.

### 7.4 Settings

Fields: bot token (masked; "Change token" reveals an input), projects folder, idle minutes, log level, agent + CLI
path, default model and effort (from the provider catalog), "Show tray icon at login". "Save" validates the
whole config and shows errors under each field; with a running daemon a banner "Restart to apply" appears.

### 7.5 Log

Live view of the newest worker log (last 2,000 lines kept): time, coloured level, message, collapsible extra
fields. Level filter (All / Info / Warn+ / Error), text search, "Pause scrolling", "Open log folder", and a
second tab for `supervisor.log`. Empty state "No logs yet" with a Start button.

### 7.6 Tray menu

Icon colour by state (green running, grey stopped, red error). Status line "Running · @bot". Items: Open
agentpager, Start/Stop, Restart, "Quit app (bot keeps running)". Closing the window hides it; the first time, a
notification explains the bot keeps running. A second launch focuses the existing window.

## 8. Data flow

### 8.1 Bridge

- Renderer: `sandbox: true`, `contextIsolation: true`, no `nodeIntegration`, CSP without remote content.
- Preload exposes only `window.agentpager`, typed by `src/shared/api.ts`:
  `config.load/save/verifyToken`, `users.add/remove/unpair`, `daemon.start/stop/restart`, `autostart.set`,
  `agent.detect`, `dialog.pickFolder/pickExecutable`, `shell.openLogFolder`, events `onStatus`,
  `onConfigChanged`, and `logs.subscribe(source, onLines)` returning an unsubscribe function.
- Calls use `ipcRenderer.invoke` / `ipcMain.handle`. Handlers check the sender is the app's own window, validate
  input with zod, and never throw across the bridge: they return `{ ok: true, data }` or
  `{ ok: false, error: { code, message, fieldErrors? } }`. `fieldErrors` maps `ConfigError` issues to fields by
  their path prefix (e.g. `projectsRoot: …` → `projectsRoot`).

### 8.2 Main-process controller

- Config through `ConfigStore` (validated, atomic). Saves send only changed fields through `update()`, which
  re-reads the file first. `config.load` returns the token masked; a new token travels renderer → main only when
  the user changes it; `verifyToken` calls `getMe` in the main process.
- Users: `configStore.update` then the core's users-changed notification.
- Daemon: start spawns `process.execPath --daemon` detached with `windowsHide` (dev: the electron binary with the
  built main entry and `--daemon`), then the core's wait-for-ready/fatal; stop/restart via core control.
- Autostart: target `{ command: process.execPath, args: ['--daemon'], workingDir: homedir }`.
- Tray-at-login: `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`. `--hidden` starts the app with
  the tray only (no window); a normal launch opens the window.

### 8.3 Live updates

- **Status**: poll IPC `status` every 2 s while the app runs; push `onStatus` and update the tray only when the
  value changes.
- **Config**: `fs.watch` on the app-data folder, 300 ms debounce; on `config.json` changes push
  `onConfigChanged` (pairing by the worker, CLI edits).
- **Logs**: a subscription starts core `followLog` for the source; lines are sent in 250 ms batches; the follow
  stops on unsubscribe, when the Log screen closes or the window hides.

### 8.4 Badge state

From `SupervisorStatus.workerState` and `lastError`. When no daemon answers, the latest fatal worker error in
`supervisor.log` since the last Start from this app shows **Error** instead of **Stopped**.

## 9. Error handling and edge cases

- **IPC** — `not_running` → Stopped; `timeout` → "Bot not responding" with "Open log folder" (never treated as
  stopped); `unauthorized` (stale `daemon.json` token) → "Lost connection to the bot" with Restart.
- **Fatal start** — the fatal message is shown with a matching action (invalid token → "Change token").
- **Config invalid** — Settings is prefilled from a best-effort raw JSON parse, a banner lists every issue, and
  saving requires full validation. Unparseable JSON → "Open config file" or "Run wizard again" (asks before
  overwriting).
- **Config changed elsewhere with unsaved edits** — banner "The config was just changed elsewhere" with "Reload"
  / "Keep my edits"; saving still sends only changed fields.
- **Instances** — the GUI uses `requestSingleInstanceLock`; `--daemon` skips it (the core already refuses a second
  daemon via IPC `ping` and `bot.lock`). App and CLI share the task/label name, so the last autostart
  registration wins; Status offers to switch it.
- **Autostart failures** — the toggle reverts and a toast shows the error text. Missing target paths →
  "Fix autostart" re-registers the current executable.
- **Claude Code** — CLI not found → warning with file picker; not logged in / limits → reported by the bot in
  Telegram and visible in Log.
- **App errors** — main `uncaughtException` / `unhandledRejection` → `logs/desktop.log` + error dialog, never
  touching the daemon. `render-process-gone` → log and reload once; a second crash shows a message instead of
  looping.
- **Quit** — "Quit app" closes GUI and tray only. macOS shows the Dock icon only while the window is open.
- **Logs** — no log yet → empty state; rotation is followed by `followLog`.

## 10. Testing

- **`packages/core`** — existing suites move unchanged; `control/` tests move with the logic from the CLI; new
  tests for generic autostart targets (both shapes, Windows script + plist round-trip) and `launcher` in
  `daemon.json` (present, absent).
- **Main process** (node env, fake core deps) — config save field-error mapping and token masking; users actions
  with reload; daemon start/stop/restart and the `--daemon` spawn command; autostart target; status polling
  pushes only on change; config watcher debounce; log batching and unsubscribe; handlers rejecting invalid input
  and foreign senders; `--daemon` argv routing.
- **Renderer** (jsdom + React Testing Library, fake `window.agentpager`) — wizard (token check messages, username
  chips, pairing turning ✅), Settings (field errors, changed-elsewhere banner, restart banner), Users actions,
  Log filter and pause, badge states.
- **Packaged smoke** (Playwright `_electron`, CI on windows-latest and macos-latest) — launch the unpacked app with
  a temporary `AGENTPAGER_HOME` and see the wizard; run `<exe> --daemon` with no config and assert the worker
  forks, the supervisor logs the fatal "no config" error, the process exits 1 and `daemon.json` is removed. This
  is the gate for the Electron-specific risks (section 12).
- **Live (Windows, the user's machine)** — wizard → pairing → Start/Stop/Restart → autostart running
  `<exe> --daemon` → a Claude turn over Telegram → live Log → tray.

## 11. Development, build and CI

- `npm run dev -w apps/desktop` — electron-vite with renderer hot reload; Start in dev launches the electron binary
  with the built main entry and `--daemon`.
- Root `npm run check` / `npm run build` run in both workspaces.
- B build: `electron-vite build` then `electron-builder --dir` (unpacked, unsigned) for Windows and macOS. Files
  that must stay outside the asar archive: the SDK's Claude platform binary, and pino / pino-roll / thread-stream
  worker files.
- CI keeps the core matrix (Windows/macOS × Node 22/24, `npm pack --dry-run -w packages/core`) and adds a desktop
  job on Windows and macOS: typecheck + lint + test → build → `electron-builder --dir` → packaged smoke.
- `CLAUDE.md` and `lessons.md` are updated for the new layout.

## 12. Risks checked first (spike before screens)

1. `child_process.fork` from an Electron 44 main process runs the worker as plain Node (worker sees Node APIs,
   `process.send` works) on Windows and macOS.
2. `<exe> --daemon` stays windowless and exits cleanly (no Chromium window, no Dock icon, no console window).
3. Packaged (asar) builds can run pino transports and the SDK's platform binary.

If any fails, the spike records the failure and the fallback is chosen before building screens (for 1: Electron
`utilityProcess.fork` or spawning `<exe>` with `ELECTRON_RUN_AS_NODE=1`; for 3: extra `asarUnpack` entries).
