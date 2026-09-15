# agentpager app releases — design (sub-project C)

Status: 2026-09-15. Decisions in section 1 and the icons/packaging/pipeline outline were approved in conversation;
the user asked to continue without stopping ("keep going until it is all done"), so sections 4–10 were written without a
separate review round and are open to change.

Sub-project C turns the agentpager app (`apps/desktop`, sub-project B) into something people install from GitHub
Releases: a Windows installer that updates itself, macOS disk images, an app icon, and a release pipeline. The npm
package (agentpager cli) is unchanged except for the "busy" status the updater needs.

## 1. Decisions

- **No paid signing** (option B, 2026-09-14). Windows: unsigned NSIS installer; users pass SmartScreen once
  ("More info → Run anyway"). macOS: ad-hoc signed dmg; users pass Gatekeeper once ("Open Anyway" or `xattr`).
- **Windows updates itself** (electron-updater, GitHub provider): background download, the user clicks "Update".
  The bot is never stopped without that click.
- **macOS only announces updates** and opens the download page (Squirrel.Mac requires a Developer ID).
- **macOS builds for Apple Silicon and Intel**: two dmg files, each built natively (`macos-latest`, `macos-15-intel`,
  the last Intel runner, available until August 2027).
- **Busy check**: "Update" while the agent runs a turn asks first and can wait until the bot is idle. The core
  reports its active turn count (agentpager cli 0.1.3).
- **Icon**: a pager (with a `>_` screen and a signal arc) in a full and a simplified variant; tray icon is
  the pager glyph plus a status dot.
- **Versioning**: the app has its own semver (`apps/desktop/package.json`, first release `0.1.0`), released with tags
  `vX.Y.Z`. electron-updater only accepts `v`-prefixed semver tags (`app-v…` tags are skipped). The cli keeps npm
  releases only and never creates GitHub Releases.
- **Non-goals**: code signing and notarization, macOS auto-update, Linux packages, update channels (beta), delta
  updates beyond what NSIS blockmaps give for free, auto-install without a click, uninstalling the npm cli.

## 2. Icons

Sources in `apps/desktop/build/icons/` (SVG, 100×100 view box unless noted):

| File | Content | Used for |
|---|---|---|
| `app-full.svg` | Blue (`#2563eb`) rounded square, white pager body, dark screen (`#0f1b3d`) with green (`#4ade80`) `>_`, three buttons, two signal arcs | ICO 48–256 |
| `app-small.svg` | Same shapes simplified: no buttons, one arc, larger body and screen, thicker `>_` | ICO 16–32 |
| `app-mac.svg` | `app-full` artwork scaled to the macOS icon grid: 1024 canvas, 824×824 rounded square centred (100 px margin) | macOS app icon (1024 PNG) |
| `tray.svg` | Pager glyph with a transparent screen cut-out and `>_`, a status dot at the bottom right with a transparent ring; `{{fg}}` and `{{dot}}` placeholders | tray PNGs |

`npm run icons -w apps/desktop` (`scripts/renderIcons.ts`, `@resvg/resvg-js` 2.6.2 as a devDependency; its platform
binaries are optional dependencies, no install script) writes:

- `build/icon.ico` — entries 16, 20, 24, 32 from `app-small.svg` and 48, 64 from `app-full.svg` as 32-bit DIB (BGRA +
  AND mask), 128 and 256 from `app-full.svg` as PNG. DIB for the small sizes keeps NSIS and old shell code happy.
- `build/icon-mac.png` — 1024×1024 from `app-mac.svg`; electron-builder converts it to `.icns` (`mac.icon`).
- `resources/tray/<theme>-<color>.png` and `…@2x.png` — theme `light` (dark glyph `#1f2937` for light bars) and `dark`
  (white glyph for dark bars) × color `green`, `amber`, `grey`, `red` (the existing tray RGB values) × 16 and 32 px.

Generated files are committed. CI runs `npm run icons` and fails on `git diff --exit-code` so sources and outputs never
drift. The ICO writer is a pure function (`buildIco(entries)`) with unit tests (header, directory, DIB layout, PNG
entries); the tray file list is a pure function shared by the generator and the runtime loader.

Runtime: `trayIcon.ts` loads `resources/tray/<theme>-<color>.png` (plus `@2x`) through `nativeImage.createFromPath`
from `app.getAppPath()` (works in dev and inside `app.asar`); `circlePng` is removed. Theme: Windows uses
`nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` (taskbar), macOS `nativeTheme.shouldUseDarkColors` (menu bar);
`nativeTheme` `updated` re-renders the tray. The tray icons are not template images, so a tinted macOS menu bar may
not match exactly (accepted).

## 3. Packaging (`electron-builder.yml`)

- `win.target: nsis` (x64), `win.icon: build/icon.ico`.
- `nsis`: `oneClick: true`, `perMachine: false` (installs to `%LOCALAPPDATA%\Programs\agentpager`, no admin),
  `runAfterFinish: true`, `createDesktopShortcut: true`, `createStartMenuShortcut: true`,
  `deleteAppDataOnUninstall: false`, `include: build/installer.nsh`,
  `artifactName: agentpager-Setup-${version}.exe`.
  `deleteAppDataOnUninstall` must stay false: the NSIS app-data folder is `%APPDATA%\agentpager`, the bot's own
  folder shared with the cli. A unit test reads the YAML and asserts it.
- `mac.target: dmg`, `mac.identity: "-"` (ad-hoc), `mac.hardenedRuntime: false`, `mac.gatekeeperAssess: false`,
  `mac.icon: build/icon-mac.png`, `dmg.artifactName: agentpager-${version}-${arch}.dmg`.
  Hardened runtime stays off: ad-hoc signatures with library validation break Electron's framework loading.
- `publish: { provider: github, owner: nguyenkechien, repo: agentpager, releaseType: draft }` — also generates
  `app-update.yml` inside the Windows build.
- `files` gains `resources/tray/**`. `electron-updater` becomes a runtime dependency (externalized like the others).
- `npm run pack` stays `--dir`; new `npm run dist` builds installers locally (`--publish never`), guarded by
  `ensureReleaseFree` like `pack`.

## 4. Windows: install, update, uninstall

### 4.1 Launch modes

`parseLaunchMode` gains two maintenance modes. Like `--daemon`, they never open a window or tray, and are checked
before the single-instance lock:

- `--prepare-update` — make this installation's files replaceable.
- `--uninstall-cleanup` — undo machine-wide settings that point at this installation.

Both run `runMaintenance(kind)` in `src/main/maintenance.ts` and exit 0 on success, 1 on failure (details in
`desktop.log`). The exit code is informational: the installer continues either way and its own process check remains
the fallback.

`prepareUpdate(deps)`:

1. Ask a running agentpager GUI to quit: `app.requestSingleInstanceLock({ command: 'quit-for-update' })`. When the lock
   is held elsewhere, the primary instance receives `second-instance` with that data and quits (closing the window
   without the tray notice). Wait until the lock can be taken (poll every 200 ms, up to 10 s).
2. Read `daemon.json` and status. If a daemon runs and its launcher is `app` with an executable equal
   (case-insensitive on Windows) to this process's `execPath`: write `update-resume.json`
   (`{ version: 1, requestedAt, fromVersion }`) in the app-data root, then `stopDaemon` (graceful, 25 s timeout).
   A daemon started by the cli or by another copy of the app is left alone: its files are not being replaced.
3. Never delete an existing `update-resume.json` (the in-app flow may have written it before stopping the daemon).

`uninstallCleanup(deps)`:

1. Quit the GUI as above; stop the daemon if it runs from this installation (no resume marker).
2. If autostart is enabled and its target is this executable, disable it. A target pointing at the cli or another
   copy is left alone.
3. Remove the login item (`app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] })`).
4. With `AGENTPAGER_HOME` set, steps 2–3 are skipped (same rule as the app's switches).

### 4.2 Installer hooks (`build/installer.nsh`)

- `customCheckAppRunning`: if `$INSTDIR\agentpager.exe` exists, `ExecWait '"$INSTDIR\agentpager.exe" --prepare-update'`,
  then insert electron-builder's default `_CHECK_APP_RUNNING` (kills anything still running from `$INSTDIR`).
  This covers both the auto-update path and a manually downloaded installer run over a running bot.
- `customUnInstall`: `${ifNot} ${isUpdated}` → `ExecWait '"$INSTDIR\agentpager.exe" --uninstall-cleanup'`, then
  `RMDir /r "$APPDATA\agentpager-desktop"` (the app's Chromium profile, unlocked once the GUI quit). During an update
  the old uninstaller runs with `isUpdated`, so autostart and the login item survive (the install path is unchanged).
  `%APPDATA%\agentpager` (config, state, logs) is never removed.

### 4.3 Resume after install

On GUI start (`startAppShell`, before the window), `resumeAfterUpdate(deps)`:

- No `update-resume.json` → nothing.
- Marker younger than 30 minutes → delete it, start the daemon through `DaemonService.start()` unless one already
  runs, and show a notification "Updated agentpager to vX.Y.Z" (plus "The bot is running again." or the start error).
- Older marker → delete it, log it, do not start (a stale marker must not start a bot days later).
- Invalid JSON → delete it and log.

The installer starts the new app after both the silent update (`quitAndInstall(true, true)`) and the interactive
installer (`runAfterFinish`).

### 4.4 Update service (`src/main/update/`)

`UpdateService` owns the state shown in the UI and the tray. It is created only for packaged builds without
`AGENTPAGER_HOME` (tests and experiments never touch the network or the installation); otherwise the state is
`{ kind: 'disabled', reason }`.

```ts
type UpdateView =
  | { kind: 'disabled'; reason: 'development' | 'home_override' }
  | { kind: 'idle'; currentVersion: string; checkedAt: string | null }
  | { kind: 'checking'; currentVersion: string }
  | { kind: 'downloading'; currentVersion: string; version: string; percent: number }
  | { kind: 'ready'; currentVersion: string; version: string; notes: string | null }        // Windows
  | { kind: 'available'; currentVersion: string; version: string; downloadUrl: string }    // macOS
  | { kind: 'waiting_idle'; currentVersion: string; version: string; activeTurns: number }
  | { kind: 'installing'; currentVersion: string; version: string }
  | { kind: 'error'; currentVersion: string; message: string; checkedAt: string | null };
```

Two sources implement `UpdateSource { check(): Promise<void>; onEvent(listener) }`:

- `WindowsUpdateSource` wraps electron-updater: `autoDownload = true`, `autoInstallOnAppQuit = false` (quitting the app
  must never replace files under a running bot), logger → `desktop.log`. Events map to `checking`, `downloading`,
  `ready`, `idle` (no update), `error`.
- `MacReleaseSource` requests `https://api.github.com/repos/nguyenkechien/agentpager/releases/latest` with Electron
  `net.fetch`, validates the JSON with zod, compares `tag_name` (without `v`) to `app.getVersion()` with `semver`
  (already in the tree through electron-updater; added as a direct dependency), and picks the asset
  `agentpager-<version>-<arch>.dmg` for `process.arch`, falling back to the release `html_url`.

Schedule: first check 10 s after start, then every 6 hours, plus "Check for updates" on demand. Checks never overlap;
a manual check during a check returns the current state. Network errors become `error` and the next scheduled check
retries.

`install(mode: 'ask' | 'when_idle' | 'now')` (Windows, state `ready` or `waiting_idle`):

1. Read the daemon status. `ownsDaemon` = launcher `app` with this `execPath`.
2. If `ownsDaemon` and the daemon is running and `mode === 'ask'`:
   - `activeTurns > 0` → return `{ kind: 'busy', activeTurns }`;
   - `activeTurns === null` (daemon from core ≤ 0.1.2) → return `{ kind: 'busy_unknown' }`.
3. `mode === 'when_idle'` → state `waiting_idle`; every status push from `StatusPoller` re-checks; at 0 (or daemon no
   longer running) continue with step 4. `cancelWaiting()` returns to `ready`.
4. `ownsDaemon` and running → write `update-resume.json`, `stopDaemon`. A stop timeout or failure returns to `ready`
   with the error shown; nothing is installed.
5. State `installing`, `autoUpdater.quitAndInstall(true, true)`.

`install` on macOS is `openDownload()`: `shell.openExternal(downloadUrl)` after checking the URL starts with
`https://github.com/nguyenkechien/agentpager/`.

### 4.5 UI

- `window.agentpager.update`: `get()`, `check()`, `install(mode)`, `cancelWaiting()`, `openDownload()`, and
  `onUpdate(listener)` push (`EVENTS.update`).
- `UpdateBanner` at the top of the content area on every screen for `ready`, `available`, `waiting_idle` and
  `installing`:
  - `ready`: "New version vX.Y.Z" + button "Update" (bot text: "The bot will stop for about half a minute, then start again.").
  - `available` (macOS): "New version vX.Y.Z" + "Download".
  - `waiting_idle`: "Will update to vX.Y.Z when the agent is idle" ("N turns still running") + "Update now" + "Cancel".
  - `installing`: "Installing vX.Y.Z…".
- Busy dialog (renderer modal) for `busy`: "The agent is running N turns. Updating now stops that work (the session is kept, and you can keep chatting once the bot is back)."
  buttons "Update when idle", "Update now", "Cancel". For `busy_unknown`: "The bot runs an older core that cannot tell
  whether the agent is busy." buttons "Update now", "Cancel".
- Settings screen section "Version": current version, state line (last check time, downloading %, error text),
  button "Check for updates" (disabled while checking or when `disabled`).
- Tray: item "Update to vX.Y.Z" (state `ready`, runs `install('ask')` and opens the window when busy) or
  "Download vX.Y.Z" (macOS `available`).

## 5. macOS specifics

- **Location**: on GUI start of a packaged build, if `!app.isInApplicationsFolder()`, ask "Move agentpager to the Applications
  folder?" (Move / Later). "Move" calls `app.moveToApplicationsFolder()` (Electron relaunches from there).
  Declining is remembered in `desktop.json` for this path only.
- **Autostart guard**: `AutostartService.set(true)` refuses when the executable path contains `/AppTranslocation/` or
  `/Volumes/` (running from a quarantine copy or the disk image): "Move agentpager to Applications before turning
  on autostart." A LaunchAgent pointing there breaks after reboot.
- **Uninstall**: Settings "Uninstall agentpager from this computer…" (macOS only) confirms, runs `uninstallCleanup`, reveals the app
  in Finder (`shell.showItemInFolder`) with the text "Drag agentpager to the Trash to finish uninstalling.", then quits. Windows uses
  "Apps & features", which runs the NSIS uninstaller.
- **Gatekeeper** (docs only): first open shows "Apple could not verify…"; System Settings → Privacy & Security →
  "Open Anyway", or `xattr -dr com.apple.quarantine /Applications/agentpager.app`.

## 6. Core: busy status (agentpager cli 0.1.3)

- `SessionManager.activity(): { activeTurns: number; queuedInputs: number }` — `activeTurns` counts chats in `running`
  or `starting`; `queuedInputs` sums queue lengths. `SessionManagerDeps.onActivity?(activity)` is called whenever
  either number changes (turn start, finish, stop, queue push/dequeue, shutdown clear).
- Worker → supervisor message `{ type: 'activity'; activeTurns: number; queuedInputs: number }` (sent from
  `startWorker` through a `WorkerDeps.onActivity` hook wired in `workerEntry`).
- `SupervisorStatus` gains `activeTurns: number | null` and `queuedInputs: number | null`: `0` from a running worker
  until it reports, reset to `0` on spawn; `null` only when parsed from an older daemon.
- `control` `statusSchema`: both fields `z.number().int().nonnegative().nullable().default(null)` so the app and cli
  still read 0.1.x daemons.
- `when_idle` waits for `activeTurns === 0 && queuedInputs === 0`.
- `agentpager status` prints "Work: running N turns, M queued messages" (or "idle"); omitted for old daemons.
- CHANGELOG 0.1.3; the user publishes; the app depends on `0.1.3`.

## 7. Switching the bot from the cli to the app

The Status screen already offers "Switch autostart to this app". C adds, when the running daemon's launcher is
`cli`: "Run the bot from this app" → confirm → `DaemonService.switchToApp()` = `stopDaemon` then `startDaemon` from the
app (the same code as Stop + Start, one busy state). No automatic takeover at install.

## 8. Release pipeline

`.github/workflows/release.yml`:

- Triggers: `push` tags `v*` (build, smoke, publish draft) and `workflow_dispatch` (build and smoke only, artifacts
  uploaded to the run).
- `verify` job (ubuntu): `tsx apps/desktop/scripts/checkReleaseTag.ts <tag>` — the tag equals `v` + app version and
  `apps/desktop/CHANGELOG.md` has a section for it.
- On tag runs `verify` also creates the draft: `gh release create vX.Y.Z --draft --verify-tag --title vX.Y.Z
  --notes-file <notes>`, notes from `scripts/releaseNotes.ts` (the CHANGELOG section). An existing draft for the tag
  is reused (re-run); an existing published release fails the job.
- `windows` (windows-latest), `mac-arm64` (macos-latest), `mac-x64` (macos-15-intel), each: `npm ci`, build core,
  `npm run check`, `npm run icons` drift check, `electron-builder --<platform> --publish never` (with a `publish`
  config this still writes `latest.yml` and the blockmap), installer smoke, then on tag runs
  `gh release upload vX.Y.Z <files> --clobber`. Nothing is uploaded unless the smoke passed.
  `permissions: contents: write` only on the jobs that upload.
- `finalize` job (tag runs, after all three): `scripts/checkReleaseAssets.ts` asserts the draft has exactly
  `agentpager-Setup-X.Y.Z.exe`, `agentpager-Setup-X.Y.Z.exe.blockmap`, `latest.yml`, `agentpager-X.Y.Z-arm64.dmg`,
  `agentpager-X.Y.Z-x64.dmg`, and that `latest.yml` names the uploaded setup file and its sha512.
- The user reviews the draft and clicks Publish; only then Windows installs see the update.

CI (`ci.yml`) additionally runs the icon drift check. Release steps are documented in `apps/desktop/README.md`
("Releasing").

## 9. Testing

Unit (vitest, `apps/desktop/tests/main`):
- `icons`: ICO structure, tray file list, generator writes every file.
- `electronBuilderConfig`: `deleteAppDataOnUninstall: false`, NSIS include path, publish owner/repo/draft, artifact names.
- `maintenance`: `prepareUpdate` / `uninstallCleanup` with fakes (own daemon vs cli daemon vs other copy, marker
  preserved, autostart owned vs foreign, home override).
- `resumeAfterUpdate`: fresh, stale, invalid marker; daemon already running; start failure.
- `updateService`: every transition, overlapping checks, busy / busy_unknown / when_idle / cancel, stop timeout,
  disabled modes, schedule.
- `macReleaseSource`: newer / same / older / malformed / missing asset / network error.
- `autostartService`: translocation and `/Volumes/` refusal.
- `releaseNotes`, `checkReleaseTag`, `checkReleaseAssets`.
Renderer: `UpdateBanner`, busy dialog, Settings version section, Status "Run the bot from this app", macOS uninstall button.
Core: `SessionManager.activity` and `onActivity`, supervisor activity status, status schema defaults, cli status line.

Installer smoke (Playwright + scripts, in `release.yml` and runnable locally):
- Windows: silent install of the built setup into the runner profile; the existing app smoke against the installed
  exe (`AGENTPAGER_EXE`); start an installed `--daemon` with a temp home, run `--prepare-update` with that home → the
  daemon stopped gracefully (`supervisor finished` in the log) and `update-resume.json` exists; launch the GUI → the
  daemon runs again and the marker is gone; silent uninstall → install folder and shortcuts gone, a sentinel file in
  `%APPDATA%\agentpager` still present.
- macOS: mount the dmg, copy the app to a temp folder, `codesign --verify --deep --strict`, the existing app smoke
  against the copy (`AGENTPAGER_EXE`), the SDK's `claude` binary runs `--version` from the copied app.

Live check (the user):
- Windows: install v0.1.0 from the published release over the unpacked build's autostart (autostart switch moves to the
  installed app); publish v0.1.1 → the app shows the update; with a turn running, "Update when idle" waits, then
  installs; bot answers after; autostart still points at the install; uninstall keeps config and removes autostart.
- macOS (the user's Mac): dmg → Gatekeeper → move to Applications → wizard or existing cli config → switch from cli →
  autostart → reboot → bot answers; v0.1.1 shows "Download".

## 10. Documentation

- `apps/desktop/README.md`: download, install on Windows (SmartScreen) and macOS (Gatekeeper, Applications),
  updates, uninstall (data kept), app and cli sharing one bot, release steps for maintainers.
- `packages/core/README.md` and root `README.md`: link to Releases instead of "no installer yet".
- `apps/desktop/CHANGELOG.md` (new), `packages/core/CHANGELOG.md` 0.1.3, `CLAUDE.md` (release layout, commands),
  `lessons.md`.
