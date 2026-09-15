# agentpager app releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship agentpager app as a self-updating unsigned Windows installer and ad-hoc signed macOS disk images (arm64, x64) with a new icon, built and drafted by a tag-triggered release workflow.

**Architecture:** electron-builder produces NSIS and dmg targets; small launch modes of the app itself (`--prepare-update`, `--uninstall-cleanup`) make installer hooks stop the bot gracefully and undo machine-wide settings. An `UpdateService` in the main process wraps electron-updater on Windows and a GitHub release check on macOS, and waits for the core's new active-turn count before stopping the bot. Icons are SVG sources rendered to committed ICO/PNG files by a script.

**Tech Stack:** Electron 44.3.0, electron-builder 26.15.3 (NSIS, dmg), electron-updater 6.8.9, semver, @resvg/resvg-js 2.6.2 (dev), React 19, vitest 5, Playwright 1.63, GitHub Actions, `gh` CLI.

Spec: `docs/superpowers/specs/2026-09-15-agentpager-release-design.md`.

## Global Constraints

- No paid signing: Windows unsigned NSIS; macOS `identity: "-"`, `hardenedRuntime: false`.
- Release tags are `vX.Y.Z` and must equal `apps/desktop/package.json` version; first release `0.1.0`.
- `nsis.deleteAppDataOnUninstall` must be `false`: `%APPDATA%\agentpager` is the bot's folder shared with the cli.
- The bot is never stopped by an update without the user's click; `autoInstallOnAppQuit = false`.
- Update checks, autostart and login item changes never run with `AGENTPAGER_HOME` set, nor in unpackaged builds (update).
- Never run a test daemon without a temporary `AGENTPAGER_HOME`; never stop the user's real bot or repack while it runs from `release/` without the user's consent.
- UI strings Vietnamese; code comments English; `src/core` stays provider-neutral.
- Pin exact dependency versions (repo convention). TypeScript stays 6.0.3.
- `npm run check` (root) green before every commit; no `eslint-disable`, `any`, `.skip`, swallowed errors.
- The user runs `npm publish` (core 0.1.3) and clicks Publish on GitHub drafts.

---

### Task 1: Spike — Windows build mechanics

Verify the assumptions the rest of the plan depends on, on this Windows machine, in a scratch copy (never `apps/desktop/release` while the bot runs from it).

**Files:** none committed except a lessons entry; scratch under the session scratchpad.

- [ ] `npm install -D @resvg/resvg-js@2.6.2 -w apps/desktop` installs without install scripts; render `app-full.svg` to a 256 PNG in a tsx one-off.
- [ ] Copy `apps/desktop` build output (`out/`, `package.json`, config) to scratch; add `win.target: nsis`, `publish` (github, draft), `nsis.include` with a `customCheckAppRunning` macro that `DetailPrint`s and inserts `_CHECK_APP_RUNNING`; `electron-builder --win --publish never --config <scratch yml>` with `--projectDir` scratch. Expect `agentpager-Setup-0.1.0.exe`, `.blockmap`, `latest.yml` in the output dir and `resources/app-update.yml` in `win-unpacked`.
- [ ] Build an ICO with DIB 16–64 + PNG 128/256 entries and confirm electron-builder/NSIS accept it (installer builds, exe icon shows in Explorer).
- [ ] Two-process test of `app.requestSingleInstanceLock(additionalData)`: primary receives `second-instance` with the data and quits; the second process re-acquires the lock by calling `requestSingleInstanceLock` again after the primary exits.
- [ ] Record results (and anything that differs) in the plan's "Spike results" note under this task and in `lessons.md`.

Findings that contradict the spec stop the plan: report to the user before continuing.

**Spike results (2026-09-15, Windows):**
- `@resvg/resvg-js` 2.6.2 installs without install scripts and renders the icon SVG (16 and 256 px checked by eye). `npx tsx -e` hung in this shell; plain `node` scripts work.
- `electron-builder --win --publish never` with a GitHub `publish` block writes `agentpager-Setup-0.1.0.exe`, `.blockmap`, `latest.yml`, and `resources/app-update.yml` (`releaseType: draft`).
- Defining `customCheckAppRunning` makes electron-builder skip `!include "getProcessInfo.nsh"` and `Var pid`; `_CHECK_APP_RUNNING` then fails with `Invalid command: "${GetProcessInfo}"`. `installer.nsh` must include both itself (top level, outside the macro).
- `app.requestSingleInstanceLock(additionalData)`: the primary receives `second-instance` with the data (once per attempt), and the second process gets the lock ~0.8 s after the primary exits by calling it again every 200 ms.
- `electron` downloads its binary on first `require('electron')`; `node_modules/electron/dist` is empty until then.
- ICO acceptance by NSIS is checked in Task 4 with the generated icon.

### Task 2: Core — active turns in daemon status (agentpager cli 0.1.3)

**Files:**
- Modify: `packages/core/src/core/sessions/manager.ts` (activity tracking), `packages/core/src/core/worker.ts` (`WorkerDeps.onActivity`), `packages/core/src/daemon/workerEntry.ts` (send), `packages/core/src/daemon/supervisor.ts` (message + status fields), `packages/core/src/control/daemon.ts` (schema defaults), `packages/core/src/cli/commands/status.ts` (line), `packages/core/package.json` (0.1.3), `packages/core/CHANGELOG.md`, `apps/desktop/package.json` (core 0.1.3), root `package-lock.json`.
- Test: `packages/core/tests/core/sessions/manager.test.ts`, `tests/daemon/supervisor.test.ts`, `tests/control/daemon.test.ts`, `tests/cli/status.test.ts` (existing files; add cases).

**Interfaces:**
- Produces: `export interface SessionActivity { activeTurns: number; queuedInputs: number }`; `SessionManager.activity(): SessionActivity`; `SessionManagerDeps.onActivity?: (activity: SessionActivity) => void`; `WorkerDeps.onActivity?: (activity: SessionActivity) => void`; `WorkerToSupervisor` adds `{ type: 'activity'; activeTurns: number; queuedInputs: number }`; `SupervisorStatus.activeTurns: number | null`, `SupervisorStatus.queuedInputs: number | null`.

- [ ] Tests (manager): `activity()` is `{0,0}` initially; submit → `{1,0}` and `onActivity` called once with it; second submit while busy → `{1,1}`; turn finishes with queue → next turn starts, `{1,0}`; last finishes → `{0,0}`; `stop()` drops the queue → queued 0 reported; `shutdown()` clears; a provider `startTurn` throwing reports back to `{0,0}`; identical consecutive states are not reported twice.
- [ ] Implement: `private lastActivity = { activeTurns: 0, queuedInputs: 0 }`; `activity()` = `activeTurns: new Set([...this.running.keys(), ...this.starting]).size`, `queuedInputs` = sum of queue lengths; `private reportActivity()` compares and calls `deps.onActivity`. Call it after every mutation of `running`, `starting`, `queues` (submit push/add/delete, stop delete, startTurn set and failure path, completeTurn limit delete / starting add+delete / dequeue, finishTurn delete, shutdown clear).
- [ ] Tests (supervisor): new status has `activeTurns: 0, queuedInputs: 0`; an `activity` message from the current worker updates both; a message from an old entry is ignored; spawn after crash resets to 0.
- [ ] Implement supervisor fields; `workerEntry` passes `onActivity: (a) => { void send({ type: 'activity', ...a }).catch(log) }` — a failed send is logged with `console.error` (process may be disconnecting), never thrown; `supervisorMessageSchema` untouched (direction worker → supervisor).
- [ ] Tests (control): `readDaemonStatus` accepts a 0.1.2 payload without the fields → both `null`; rejects negative numbers.
- [ ] Tests (cli status): running daemon with `activeTurns: 1, queuedInputs: 2` prints `Agent: đang chạy 1 lượt, 2 tin chờ`; `0/0` prints `Agent: rảnh`; `null` prints no Agent line.
- [ ] Bump core to 0.1.3 + CHANGELOG ("`agentpager status` hiện agent đang bận/rảnh; daemon báo số lượt đang chạy cho agentpager app"); desktop dependency `0.1.3`; `npm install` at root to refresh the lock.
- [ ] `npm run check` → commit `feat(core): report active turns in daemon status`.

### Task 3: Icons and tray images

**Files:**
- Create: `apps/desktop/build/icons/{app-full,app-small,app-mac,tray}.svg`, `apps/desktop/scripts/icons/ico.ts` (`buildIco`), `apps/desktop/scripts/icons/trayFiles.ts` → shared list lives in `apps/desktop/src/main/shell/trayFiles.ts` (runtime + script), `apps/desktop/scripts/renderIcons.ts`, generated `apps/desktop/build/icon.ico`, `build/icon-mac.png`, `resources/tray/*.png`.
- Modify: `apps/desktop/src/main/shell/trayIcon.ts` (load PNGs), `appShell.ts` (theme), `apps/desktop/package.json` (`icons` script, resvg dev dep), `electron-builder.yml` (`files: resources/tray/**`), `tsconfig.json`/eslint if scripts subfolder needs it, `.github/workflows/ci.yml` (drift check).
- Test: `apps/desktop/tests/main/icons/ico.test.ts`, `tests/main/shell/trayFiles.test.ts`, replace `tests/main/shell/trayIcon.test.ts`, `tests/main/icons/generated.test.ts` (every listed file exists and is a PNG of the right size).

**Interfaces:**
- Produces: `export type TrayTheme = 'light' | 'dark'`; `trayImageFile(theme: TrayTheme, color: TrayColor, scale: 1 | 2): string` (relative path `resources/tray/light-green.png` / `light-green@2x.png`); `TRAY_IMAGE_FILES: readonly { theme; color; scale; file }[]`; `buildIco(entries: readonly { size: number; rgba: Uint8Array; png: Buffer; format: 'dib' | 'png' }[]): Buffer`; `trayTheme(platform: NodeJS.Platform, theme: { shouldUseDarkColors: boolean; shouldUseDarkColorsForSystemIntegratedUI: boolean }): TrayTheme`; `loadTrayImage(appPath: string, theme: TrayTheme, color: TrayColor): NativeImage` (in appShell or trayIcon).

- [ ] Write the four SVGs from the approved concept (100 view box; `app-mac.svg` 1024 view box with the artwork in an 824 square at 100,100; `tray.svg` uses `{{fg}}`/`{{dot}}` placeholders and a `<mask>` for the screen cut-out and the dot ring so they are transparent).
- [ ] Tests for `buildIco`: header `00 00 01 00`, count; directory entry width/height byte (256 → 0), bpp 32, sizes/offsets consistent; DIB entry has `BITMAPINFOHEADER` (40), height doubled, bottom-up BGRA pixels (first stored row = last image row), AND mask row length padded to 4 bytes; PNG entry bytes equal the input PNG.
- [ ] Implement `buildIco`.
- [ ] Tests for `trayImageFile`/`TRAY_IMAGE_FILES` (16 files, names) and `trayTheme` (win32 uses the system-integrated flag, darwin uses `shouldUseDarkColors`).
- [ ] `renderIcons.ts`: resvg renders each size (`fitTo: { mode: 'width', value: size }`), `pixels` for DIB, `asPng()` for PNG; writes ICO (small 16/20/24/32 + full 48/64 DIB, full 128/256 PNG), mac 1024 PNG, tray PNGs with fg `#1f2937` (light) / `#ffffff` (dark) and dot RGB from the tray palette (green `#22c55e`, amber `#f59e0b`, grey `#94a3b8`, red `#ef4444`). Script `"icons": "tsx scripts/renderIcons.ts"`.
- [ ] Run it, look at the outputs (Read the PNGs), commit outputs; `generated.test.ts` checks every file.
- [ ] Runtime: `trayIcon.ts` exports `trayImageFile`-based loader; `appShell` computes the theme, calls `loadTrayImage(app.getAppPath(), theme, color)` (1x + `@2x` representation via `nativeImage.createFromPath` then `addRepresentation({ scaleFactor: 2, buffer: readFileSync(...) })`), re-renders on `nativeTheme.on('updated')`; remove `circlePng` and its test.
- [ ] CI: in the `desktop` job after `npm ci`: `npm run icons -w apps/desktop` then `git diff --exit-code -- apps/desktop/build apps/desktop/resources`.
- [ ] Dev check: `npm run dev -w apps/desktop` with a temp `AGENTPAGER_HOME` shows the new tray icon (user or screenshot); `npm run check` → commit `feat(desktop): pager app icon and tray images`.

### Task 4: Packaging configuration and installer hooks

**Files:**
- Modify: `apps/desktop/electron-builder.yml`, `apps/desktop/package.json` (`dist` script; deps `electron-updater` 6.8.9, `semver` exact version present in the lock), `apps/desktop/scripts/ensureReleaseFree.ts` (unchanged API, reused).
- Create: `apps/desktop/build/installer.nsh`.
- Test: `apps/desktop/tests/main/electronBuilderConfig.test.ts` (reads YAML with `yaml`/`js-yaml` already in the tree — use the one resolvable from `apps/desktop`; add as devDependency if not).

**Interfaces:**
- Produces: artifact names `agentpager-Setup-${version}.exe`, `agentpager-${version}-${arch}.dmg`; `release/latest.yml`; `build/installer.nsh` macros `customCheckAppRunning`, `customUnInstall`.

- [ ] Test asserts: `nsis.oneClick === true`, `perMachine === false`, `deleteAppDataOnUninstall === false`, `include === 'build/installer.nsh'`, `runAfterFinish === true`; `win.target` nsis x64; `mac.identity === '-'`, `hardenedRuntime === false`, `mac.target` dmg; artifact names; `publish` = `{ provider: 'github', owner: 'nguyenkechien', repo: 'agentpager', releaseType: 'draft' }`; `files` includes `resources/tray/**`; `asarUnpack` unchanged; the NSIS file contains `--prepare-update`, `--uninstall-cleanup`, `${ifNot} ${isUpdated}` and `_CHECK_APP_RUNNING`.
- [ ] `installer.nsh`:

```nsis
!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping agentpager gracefully"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --prepare-update' $0
    DetailPrint "prepare-update exited with $0"
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup' $0
      DetailPrint "uninstall-cleanup exited with $0"
    ${endIf}
    RMDir /r "$APPDATA\agentpager-desktop"
  ${endIf}
!macroend
```

  (Check against the spike: `customCheckAppRunning` replaces the whole default macro, so it must insert both `IS_POWERSHELL_AVAILABLE` and `_CHECK_APP_RUNNING`.)
- [ ] `dist` script: `tsx scripts/ensureReleaseFree.ts && electron-vite build && electron-builder --publish never`.
- [ ] `npm run check` → commit `build(desktop): NSIS and dmg targets, GitHub draft publishing`.

### Task 5: Maintenance launch modes and resume after update

**Files:**
- Modify: `apps/desktop/src/main/launchMode.ts`, `src/main/index.ts`, `src/main/shell/appShell.ts` (second-instance data → quit; resume on start; expose helpers).
- Create: `apps/desktop/src/main/maintenance/resumeMarker.ts`, `src/main/maintenance/prepareUpdate.ts`, `src/main/maintenance/uninstallCleanup.ts`, `src/main/maintenance/ownDaemon.ts`, `src/main/maintenance/run.ts` (Electron wiring), `src/main/maintenance/resumeAfterUpdate.ts`.
- Test: `tests/main/launchMode.test.ts` (add), `tests/main/maintenance/{resumeMarker,prepareUpdate,uninstallCleanup,ownDaemon,resumeAfterUpdate}.test.ts`.

**Interfaces:**
- Produces:
  - `LaunchMode` adds `{ kind: 'maintenance'; task: 'prepare-update' | 'uninstall-cleanup' }` (checked after `--daemon`, before GUI).
  - `QUIT_FOR_MAINTENANCE = { command: 'quit-for-maintenance' } as const`; `isQuitForMaintenance(data: unknown): boolean`.
  - `ownsDaemon(info: DaemonInfo | null, execPath: string, platform: NodeJS.Platform): boolean` (launcher kind `app` and path equal, case-insensitive on win32).
  - `RESUME_MARKER_FILE = 'update-resume.json'`; `writeResumeMarker(root: string, fromVersion: string, now: Date): Promise<void>` (atomic write, does not overwrite an existing marker); `consumeResumeMarker(root: string, now: Date, maxAgeMs = 30 * 60_000): Promise<{ kind: 'none' } | { kind: 'fresh'; fromVersion: string } | { kind: 'stale' } | { kind: 'invalid' }>` (always deletes a found file).
  - `prepareUpdate(deps: PrepareUpdateDeps): Promise<'stopped' | 'nothing_to_stop'>` with `PrepareUpdateDeps { quitGui(): Promise<void>; readDaemonInfo(): Promise<DaemonInfo | null>; readStatus(): Promise<SupervisorStatus | null>; stopDaemon(): Promise<StopResult>; writeMarker(): Promise<void>; execPath: string; platform: NodeJS.Platform }` — throws `Error` on stop timeout.
  - `uninstallCleanup(deps: UninstallCleanupDeps): Promise<void>` with `{ quitGui; readDaemonInfo; readStatus; stopDaemon; autostart: Pick<AutostartService, 'get' | 'set'>; removeLoginItem(): void; homeOverride: string | null; execPath; platform }`.
  - `resumeAfterUpdate(deps: { consume(): ReturnType<typeof consumeResumeMarker>; status(): Promise<DaemonView>; start(): Promise<DaemonView>; notify(title: string, body: string): void; log: Pick<DesktopLog, 'info' | 'error'>; version: string }): Promise<void>`.
  - `runMaintenance(task): Promise<number>` in `run.ts` (exit code).

- [ ] launchMode tests: `--prepare-update` / `--uninstall-cleanup` map to maintenance; `--daemon` still wins.
- [ ] resumeMarker tests (temp dir): write creates JSON `{ version: 1, requestedAt, fromVersion }`; a second write keeps the first; consume fresh/stale (age boundary)/invalid JSON/none; file removed after consume.
- [ ] ownDaemon tests: app launcher same path → true; win32 case differences → true; darwin case differences → false; cli launcher → false; null info → false.
- [ ] prepareUpdate tests: GUI quit is awaited first; own running daemon → marker written before stop, returns `stopped`; stop timeout → throws, marker still written (the next GUI start resumes it or it goes stale); cli daemon → no stop, no marker, `nothing_to_stop`; no daemon → `nothing_to_stop`; status `null` with stale daemon.json → `nothing_to_stop`.
- [ ] uninstallCleanup tests: own daemon stopped, no marker; autostart owned → `set(false)`; foreign autostart untouched; login item removed; home override → autostart and login item untouched, daemon still stopped when owned.
- [ ] resumeAfterUpdate tests: none → nothing; fresh + stopped → start + notify "Đã cập nhật agentpager lên 0.1.1" / "Bot đã chạy lại."; fresh + already running → no start, notify without the bot line; start throws → notify with the error message and log; stale → log only; invalid → log only.
- [ ] Implement modules. `run.ts`: builds deps from core (`appPaths`, `readDaemonInfo`, `ipcRequest`, `stopDaemon`, `readDaemonStatus`), `quitGui` = loop: `app.requestSingleInstanceLock(QUIT_FOR_MAINTENANCE)` true → resolve; else wait 200 ms, up to 10 s then resolve (the installer's process check is the fallback; log it). Logs to `desktop.log`. `index.ts` routes maintenance mode (no hardware acceleration, dock hidden) and exits with the code.
- [ ] appShell: `second-instance` handler gets `(event, argv, cwd, additionalData)`; `isQuitForMaintenance` → `this.quitting = true; app.quit()`; otherwise show window. On start (after services, before window) call `resumeAfterUpdate` and log failures.
- [ ] `npm run check` → commit `feat(desktop): installer maintenance modes and resume after update`.

### Task 6: Update service

**Files:**
- Create: `apps/desktop/src/main/update/updateService.ts`, `src/main/update/windowsSource.ts`, `src/main/update/macReleaseSource.ts`, `src/main/update/schedule.ts`.
- Modify: `apps/desktop/src/shared/api.ts` (`UpdateView`, `InstallResult`, `InstallMode`).
- Test: `tests/main/update/{updateService,windowsSource,macReleaseSource,schedule}.test.ts`.

**Interfaces:**
- Produces (shared/api.ts):
  - `UpdateView` exactly as spec §4.4.
  - `export type InstallMode = 'ask' | 'when_idle' | 'now'`; `export type InstallResult = { kind: 'installing' } | { kind: 'waiting' } | { kind: 'busy'; activeTurns: number; queuedInputs: number } | { kind: 'busy_unknown' } | { kind: 'opened' }`.
- Produces (main):
  - `type SourceEvent = { kind: 'checking' } | { kind: 'none' } | { kind: 'downloading'; version: string; percent: number } | { kind: 'ready'; version: string; notes: string | null } | { kind: 'available'; version: string; downloadUrl: string } | { kind: 'error'; message: string }`.
  - `interface UpdateSource { readonly platform: 'windows' | 'mac'; check(): Promise<void>; onEvent(listener: (event: SourceEvent) => void): void; install(): void }` (mac `install` unused → service opens the URL).
  - `createWindowsSource(updater: Pick<AppUpdater, 'on' | 'checkForUpdates' | 'quitAndInstall'> & { autoDownload: boolean; autoInstallOnAppQuit: boolean; logger: unknown }, log: DesktopLog): UpdateSource`.
  - `createMacReleaseSource(deps: { fetchJson(url: string): Promise<unknown>; currentVersion: string; arch: string }): UpdateSource`; `RELEASES_LATEST_URL`, `DOWNLOAD_URL_PREFIX = 'https://github.com/nguyenkechien/agentpager/'`.
  - `class UpdateService { constructor(deps: UpdateServiceDeps); view(): UpdateView; onChange(listener: (view: UpdateView) => void): void; check(): Promise<UpdateView>; install(mode: InstallMode): Promise<InstallResult>; cancelWaiting(): UpdateView; onDaemonStatus(): void; dispose(): void }`.
  - `UpdateServiceDeps { source: UpdateSource | null; disabledReason: 'development' | 'home_override' | null; currentVersion: string; readDaemon(): Promise<{ info: DaemonInfo | null; status: SupervisorStatus | null }>; ownsDaemon(info: DaemonInfo | null): boolean; stopDaemon(): Promise<StopResult>; writeMarker(): Promise<void>; openExternal(url: string): Promise<void>; now(): Date; log: DesktopLog }`.
  - `startSchedule(check: () => Promise<unknown>, timers: { setTimeout; clearTimeout; setInterval; clearInterval }, firstDelayMs = 10_000, intervalMs = 6 * 3_600_000): () => void`.

- [ ] updateService tests (fake source + fakes): disabled → view `disabled`, `check`/`install` never touch the source; source events map to views (`checking`, `idle` with `checkedAt`, `downloading`, `ready`, `available`, `error` keeps last `checkedAt`); overlapping `check()` calls the source once; `install('ask')` with no daemon → marker not written, `quitAndInstall` via `source.install()`, view `installing`; own daemon busy → `busy` result, view stays `ready`; `activeTurns 0, queuedInputs 2` → `busy`; status fields `null` → `busy_unknown`; cli daemon busy → installs without stopping; `when_idle` → view `waiting_idle`, `onDaemonStatus` with still busy stays, idle → stop → install; `cancelWaiting` → `ready`; stop `timeout` → view `ready` + result error thrown as `ApiFailure({ code: 'timeout' })`, nothing installed; `now` → stops even when busy; install on `available` (mac) → `openExternal(downloadUrl)`, result `opened`; install in other states → `ApiFailure invalid_input`.
- [ ] windowsSource tests with an EventEmitter fake: `autoDownload true`, `autoInstallOnAppQuit false` set; `checking-for-update`, `update-available` (→ downloading 0), `download-progress` (percent rounded), `update-downloaded` (notes string or joined array), `update-not-available`, `error` mapped; `install()` → `quitAndInstall(true, true)`; `checkForUpdates` rejection → error event (no unhandled rejection).
- [ ] macReleaseSource tests: newer tag with matching asset → `available` with asset URL; missing asset → `html_url`; same/older → `none`; non-semver tag → `error`; invalid JSON shape → `error`; fetch throws → `error`; URL outside prefix → `error`.
- [ ] schedule tests with fake timers: first check after 10 s, then every 6 h; stop clears both.
- [ ] Implement. `fetchJson` in wiring: `net.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentpager-app' } })`, non-2xx → throw `Error('GitHub trả về <status>')`.
- [ ] `npm run check` → commit `feat(desktop): update service for Windows installs and macOS release notices`.

### Task 7: Update wiring — IPC, preload, tray

**Files:**
- Modify: `src/shared/channels.ts` (`updateGet`, `updateCheck`, `updateInstall`, `updateCancelWaiting`, `updateOpenDownload`; `EVENTS.update`), `src/shared/api.ts` (`AgentpagerApi.update`, `onUpdate`), `src/main/ipc/schemas.ts`, `src/main/mainHandlers.ts`, `src/preload/index.ts`, `src/main/shell/trayModel.ts` (update item), `src/main/shell/appShell.ts` (create service, schedule, push, tray, poller hook), `tests/renderer/fakeApi.ts`.
- Test: `tests/main/mainHandlers.test.ts`, `tests/main/preload.test.ts`, `tests/main/ipc/handlers.test.ts` (schema cases), `tests/main/shell/trayModel.test.ts`.

**Interfaces:**
- Produces: `api.update = { get: () => Promise<ApiResult<UpdateView>>; check: () => Promise<ApiResult<UpdateView>>; install: (mode: InstallMode) => Promise<ApiResult<InstallResult>>; cancelWaiting: () => Promise<ApiResult<UpdateView>>; openDownload: () => Promise<ApiResult<InstallResult>> }`; `api.onUpdate(listener: (view: UpdateView) => void): () => void`; `trayModel(view: DaemonView | null, update: UpdateView | null): TrayModel` with `TrayAction` adding `'update'` and item label `Cập nhật lên vX.Y.Z` (ready) / `Tải bản mới vX.Y.Z` (available), placed before the quit separator.

- [ ] Tests: schemas accept `install` with each mode, reject others; handlers call the service; preload maps channels and `onUpdate`; trayModel with `ready` / `available` / other states.
- [ ] Implement; appShell: `UpdateService` created with `source = app.isPackaged && homeOverride === null ? (win32 ? windowsSource(autoUpdater) : darwin ? macReleaseSource : null) : null` and `disabledReason`; `onChange` → tray re-render + `EVENTS.update`; `StatusPoller.onChange` also calls `update.onDaemonStatus()`; tray `update` action → `install('ask')`, on `busy`/`busy_unknown` show window (the renderer shows the dialog from the view) — the main process emits `EVENTS.update` plus opens the window; schedule stopped on `before-quit`.
- [ ] Busy from the tray: add `UpdateView` field? No — the renderer asks again with `install('ask')` when the user clicks the banner. The tray only opens the window when the result is busy. (Documented in the task, no extra state.)
- [ ] `npm run check` → commit `feat(desktop): update IPC, preload and tray item`.

### Task 8: Update UI

**Files:**
- Create: `src/renderer/UpdateBanner.tsx`, `src/renderer/BusyDialog.tsx`, `src/renderer/hooks.ts` (`useUpdate`).
- Modify: `src/renderer/App.tsx` (banner above screens), `src/renderer/screens/SettingsScreen.tsx` (section "Phiên bản"), `src/renderer/styles.css` (dialog, banner actions), `src/renderer/format.ts` (time formatting reuse).
- Test: `tests/renderer/UpdateBanner.test.tsx`, `tests/renderer/SettingsScreen.test.tsx` (add), `tests/renderer/App.test.tsx` (banner shows on every screen).

**Interfaces:**
- Consumes: `api.update`, `api.onUpdate`, `UpdateView`, `InstallResult`.
- Produces: `useUpdate(): { view: UpdateView | null; setView(view: UpdateView): void }`; `<UpdateBanner view={UpdateView | null} />`; `<BusyDialog result={{ kind: 'busy'; activeTurns; queuedInputs } | { kind: 'busy_unknown' }} onChoose={(mode: 'when_idle' | 'now' | 'cancel') => void} />`.

- [ ] Tests: `ready` shows "Có bản mới v0.1.1" and "Cập nhật"; click → `install('ask')`; `busy` result opens dialog with "Agent đang chạy 1 lượt" (and "2 tin chờ" when queued); "Cập nhật khi rảnh" → `install('when_idle')`; "Cập nhật ngay" → `install('now')`; "Huỷ" closes; `busy_unknown` text and two buttons; `waiting_idle` banner with "Cập nhật ngay" / "Huỷ" (→ `cancelWaiting`); `available` → "Tải bản mới" → `openDownload`; `installing` → "Đang cài bản mới…"; install error → error banner with the message; Settings section shows current version, "Đang tải 42%", last checked time, error text, button "Kiểm tra cập nhật" disabled while `checking` and hidden reason text for `disabled` ("Không kiểm tra cập nhật khi chạy từ mã nguồn" / "…khi đặt AGENTPAGER_HOME").
- [ ] Implement with existing `Banner`, `useAction`; dialog is an in-flow `role="dialog"` with `aria-modal` and focus on the first button.
- [ ] `npm run check` → commit `feat(desktop): update banner, busy dialog and version settings`.

### Task 9: macOS location guard, autostart refusal, uninstall button

**Files:**
- Modify: `src/main/services/autostartService.ts` (refusal), `src/main/shell/appShell.ts` (Applications prompt on darwin packaged; uninstall handler), `src/shared/api.ts` + channels + schemas + preload + mainHandlers (`app.uninstall`), `src/shared/labels.ts` (messages), `src/renderer/screens/SettingsScreen.tsx` (button, macOS only via `AppInfo.platform`), `src/shared/api.ts` `AppInfo` gains `platform: NodeJS.Platform` and `version: string`, `tests/renderer/fakeApi.ts`.
- Create: `src/main/shell/applicationsFolder.ts` (`shouldOfferMove`, remembered decline), tests.
- Test: `tests/main/services/autostartService.test.ts` (add), `tests/main/shell/applicationsFolder.test.ts`, `tests/renderer/SettingsScreen.test.tsx` (add), `tests/main/mainHandlers.test.ts` (add).

**Interfaces:**
- Produces: `unsafeAutostartLocation(command: string, platform: NodeJS.Platform): string | null` (message when `/AppTranslocation/` or starts with `/Volumes/` on darwin); `shouldOfferMove(input: { platform; isPackaged; inApplications: boolean; execPath: string; declinedPath: string | null }): boolean`; `api.app.uninstall: () => Promise<ApiResult<null>>`; `AppInfo { homeOverride: string | null; platform: NodeJS.Platform; version: string }`.

- [ ] Tests: autostart `set(true)` on darwin translocated/volume path → `ApiFailure invalid_input` "Hãy chuyển agentpager vào Applications trước khi bật tự khởi động."; win32 never refuses; `shouldOfferMove` matrix; Settings shows "Gỡ agentpager khỏi máy này…" only for darwin, confirm dialog text, calls `app.uninstall`.
- [ ] Implement. Applications prompt: `dialog.showMessageBox` buttons "Chuyển", "Để sau"; "Để sau" stores `{ declinedMovePath: execPath }` in `desktop.json` (merge with the tray notice key; read/write helpers extracted from `showTrayNoticeOnce`); "Chuyển" → `app.moveToApplicationsFolder()` wrapped in try/catch that shows the error (`dialog.showErrorBox`) and continues. Uninstall handler: `uninstallCleanup` (Task 5 module) → `shell.showItemInFolder(appBundlePath)` → notification "Kéo agentpager vào Thùng rác để gỡ xong" → `app.quit()`.
- [ ] `npm run check` → commit `feat(desktop): macOS Applications guard and uninstall`.

### Task 10: Switch the bot from the cli to the app

**Files:**
- Modify: `src/main/services/daemonService.ts` (`switchToApp`), channels/schemas/preload/mainHandlers/api (`daemon.switchToApp`), `src/renderer/screens/StatusScreen.tsx` (button + confirm), `tests/renderer/fakeApi.ts`.
- Test: `tests/main/services/daemonService.test.ts`, `tests/renderer/StatusScreen.test.tsx`, `tests/main/mainHandlers.test.ts`, `tests/main/preload.test.ts`.

**Interfaces:**
- Produces: `DaemonService.switchToApp(): Promise<DaemonView>` — reads daemon info; launcher not `cli` → `ApiFailure invalid_input` "Bot không chạy bằng agentpager cli"; stop (timeout → `ApiFailure timeout`), then `start()`; `api.daemon.switchToApp`.

- [ ] Tests: cli launcher → stop then start in order, returns running view; app launcher → refused; stop timeout → no start; Status screen shows "Chạy bot bằng app này" only when `launcher.kind === 'cli'` and badge running; confirm text "Bot sẽ dừng vài giây rồi chạy lại bằng agentpager app."; pending label "Đang chuyển…".
- [ ] Implement; `npm run check` → commit `feat(desktop): move a running bot from the cli to the app`.

### Task 11: Release scripts and app changelog

**Files:**
- Create: `apps/desktop/scripts/release/changelog.ts` (`changelogSection(text, version): string | null`), `scripts/release/checkReleaseTag.ts` (CLI), `scripts/release/releaseNotes.ts` (CLI, writes the notes file), `scripts/release/releaseAssets.ts` (`expectedAssets(version)`, `checkAssets(names, latestYml, setupSha512): string[]` problems), `scripts/release/checkReleaseAssets.ts` (CLI using `gh release view --json assets` and downloading `latest.yml` via `gh release download`), `apps/desktop/CHANGELOG.md` (`## 0.1.0`).
- Test: `tests/main/release/{changelog,releaseAssets,checkReleaseTag}.test.ts` (pure functions; CLIs are thin).

**Interfaces:**
- Produces: `changelogSection`, `tagProblems(tag: string, version: string, changelog: string): string[]`, `expectedAssets(version: string): string[]`, `assetProblems(input: { names: string[]; latestYml: string; setupSha512: string; version: string }): string[]`.

- [ ] Tests: section extraction between `## 0.1.0` and next `## `; missing → null; tag `v0.1.0` vs version `0.1.0` ok, `0.1.0` (no v) / `v0.1.1` mismatch / missing changelog section → problems; assets exact set (extra and missing reported); `latest.yml` `path`/`files[0].url` must equal setup name and `sha512` must equal the computed hash.
- [ ] Implement (`js-yaml` or `yaml` for latest.yml, same library as Task 4).
- [ ] CHANGELOG 0.1.0: first installable release: Windows installer with updates, macOS dmg, icon, busy-aware updates, switching from the cli.
- [ ] `npm run check` → commit `build(desktop): release tag, notes and asset checks`.

### Task 12: Installer smoke and release workflow

**Files:**
- Modify: `apps/desktop/tests/smoke/app.smoke.ts` (`AGENTPAGER_EXE` override), `apps/desktop/playwright.config.ts` (unchanged unless projects are needed).
- Create: `apps/desktop/tests/installer/windowsInstaller.smoke.ts`, `apps/desktop/tests/installer/macDmg.smoke.ts` (Playwright tests using `child_process`), `apps/desktop/playwright.installer.config.ts`, `.github/workflows/release.yml`.
- Modify: `.github/workflows/ci.yml` (icons drift from Task 3 already there).

- [ ] `app.smoke.ts`: `packagedExecutable()` returns `process.env.AGENTPAGER_EXE` when set.
- [ ] Windows installer smoke (skipped by `test.skip(process.platform !== 'win32')` is not allowed — use separate config `testMatch` per platform instead): find `release/agentpager-Setup-*.exe`; run `/S` and wait; assert `%LOCALAPPDATA%\Programs\agentpager\agentpager.exe` and Start Menu shortcut; write sentinel `%APPDATA%\agentpager\installer-smoke.txt`… — **must not touch the real app-data on a developer machine**: the test refuses to run unless `CI === 'true'` or `AGENTPAGER_INSTALLER_SMOKE=1` with a temporary `APPDATA`/`LOCALAPPDATA` (NSIS resolves `$APPDATA`/`$LOCALAPPDATA` from the shell folders, not env vars, so locally it is CI-only; the test throws with that explanation when not on CI). Steps: temp `AGENTPAGER_HOME` with the fake config → spawn installed `--daemon`, wait for daemon.json → run installed `--prepare-update` with the same env → exit 0, supervisor log has `supervisor finished`, `update-resume.json` exists → launch installed GUI with Playwright `_electron` and the env → poll until daemon.json exists again and the marker is gone → close app, stop daemon via IPC → run `Uninstall agentpager.exe /S` → install dir gone, shortcut gone, sentinel in `%APPDATA%\agentpager` still there.
- [ ] macOS dmg smoke: `hdiutil attach -nobrowse -readonly -mountpoint <tmp>` the arch's dmg, `ditto` the app to a temp folder, detach; `codesign --verify --deep --strict` exit 0; run the app smoke with `AGENTPAGER_EXE` set to the copy (spawned as a child `npx playwright test tests/smoke`); run `<copy>/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-<arch>/claude --version` exit 0 (resolve the exact path from the package's `package.json`/files during implementation).
- [ ] `release.yml` per spec §8 (jobs `verify`, `windows`, `mac-arm64`, `mac-x64`, `finalize`; `concurrency: release-${{ github.ref }}`; uploads of built installers as workflow artifacts on `workflow_dispatch`; `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` for Windows).
- [ ] Push and run `gh workflow run release.yml` on `main` (dispatch, no publish); watch; fix until all jobs green. This is where `macos-15-intel`, ad-hoc signing and the Windows installer smoke are proven.
- [ ] Commit `ci: release workflow with installer smoke`.

### Task 13: Documentation

**Files:** `apps/desktop/README.md`, `README.md`, `packages/core/README.md`, `CLAUDE.md`, `lessons.md`, plan status notes.

- [ ] Desktop README sections: Tải và cài (Windows: SmartScreen "More info → Run anyway"; macOS: dmg arm64/x64, kéo vào Applications, "Open Anyway"/`xattr -dr com.apple.quarantine /Applications/agentpager.app`), Cập nhật (Windows tự tải, bấm "Cập nhật", chờ lượt đang chạy; macOS báo và mở trang tải), Gỡ cài (Windows Apps & features; macOS nút trong Cài đặt; dữ liệu bot giữ lại), App và cli dùng chung bot, Phát triển (`npm run icons`, `npm run dist`), Phát hành (bump version + CHANGELOG → tag `vX.Y.Z` → workflow → review draft → Publish).
- [ ] Core README and root README: replace "chưa có bộ cài" with a link to `https://github.com/nguyenkechien/agentpager/releases`.
- [ ] CLAUDE.md: `apps/desktop` bullets for `update/`, `maintenance/`, icons, release workflow; commands `npm run icons`, `npm run dist`; spec/plan paths.
- [ ] lessons.md: spike and implementation lessons.
- [ ] `npm run check` → commit `docs: installing and releasing agentpager app`.

### Task 14: Local Windows installer check, first release, live check

- [ ] Ask the user before anything touching the real bot. With consent: `npm run dist -w apps/desktop` (guarded), then the user runs the setup (MSIX redirection: installs must be launched by the user), checks install, autostart switch to the installed app, tray icon light/dark, uninstall keeps config (they can reinstall afterwards).
- [ ] The user publishes `@chiennguyen/agentpager` 0.1.3.
- [ ] Tag `v0.1.0` (asked first) → release workflow → draft with 5 assets → the user reviews and publishes.
- [ ] Update path: bump to 0.1.1 with CHANGELOG, tag, draft, the user publishes; on Windows the installed 0.1.0 shows the update; test busy + "Cập nhật khi rảnh"; bot answers afterwards; autostart still points at the install.
- [ ] macOS on the user's Mac: dmg install, Gatekeeper, Applications prompt, switch from cli, autostart, reboot, v0.1.1 notice.
- [ ] Record results in this plan and lessons; commit.

---

## Progress (2026-09-15)

Done and committed (`npm run check` green: core 509 tests, desktop 249 tests):
- Task 1 spike (results above).
- Task 2 core activity status — `afab7b7`; core version 0.1.3 (not published yet: the user runs `npm publish -w packages/core`).
- Task 3 icons and tray images — `2916f80`.
- Task 4 packaging and `installer.nsh` — `43f486c` (the real NSIS installer with the generated icon builds locally).
- Task 5 maintenance modes and resume — `23bac19`.
- Task 6 update service — `841a28e`.
- Tasks 7, 9, 10 main-process wiring (IPC, preload, tray, macOS guards, switch to app) — `7055ac1`.
- Tasks 8, 9, 10 renderer (update banner, busy dialog, version section, macOS uninstall, cli switch) — `da51f8c`.
- Tasks 11–12 release scripts, installer smoke, `release.yml` — `730fa06`.
- Task 13 docs and lessons — `022ef1c`.

Interface changes against the tasks above:
- `UpdateView.disabled` carries `currentVersion`; `ready` carries `installError`; `available` carries `checkedAt`; `waiting_idle` carries `queuedInputs` too.
- `UpdateSource` is a union: `{ kind: 'windows'; install() }` or `{ kind: 'mac' }`; `startSchedule(check, onError, firstDelayMs?, intervalMs?)`.
- Maintenance lives in `src/main/maintenance/maintenance.ts` (`prepareUpdate`, `uninstallCleanup`, `QUIT_FOR_MAINTENANCE`, `isQuitForMaintenance`) plus `ownDaemon.ts`, `resumeMarker.ts`, `resumeAfterUpdate.ts`, `run.ts`.
- macOS helpers are in `src/main/shell/macLocation.ts` (`unsafeAutostartLocation`, `shouldOfferMove` with `homeOverride`, `macAppBundlePath`); `desktop.json` access moved to `desktopState.ts`.
- `AppInfo` gained `platform` and `version`; `DaemonService.switchToApp()` also accepts 0.1.x daemons without a launcher (they came from the cli).
- Added during implementation: with `AGENTPAGER_HOME` the Electron profile and single-instance lock live in `<home>/desktop-profile`, so test copies never make the real window quit or focus.
- `.gitignore`/ESLint ignored every `release/` folder, which hid `scripts/release` and `tests/main/release`; both now match only `apps/desktop/release/`.

Remaining: CI and the release dry run (`workflow_dispatch`) on Windows, macOS arm64 and macOS Intel; Task 14 with the user (publish core 0.1.3, tag v0.1.0, publish the draft, live checks on Windows and the user's Mac).
