# Lessons

## 2026-09-14 — initial build

- typescript-eslint 8.70 has a peer range `typescript <6.1.0`; the latest TypeScript (7.x) cannot be used with it. Pinned TypeScript 6.0.3.
- Agent SDK 0.3.270: `Query.interrupt()` is a control request that only works with streaming input. Always pass an `AsyncIterable<SDKUserMessage>` prompt, even for plain text, or `/stop` silently does nothing.
- `AskUserQuestion`, critical-path `rm`/`rmdir`, and `ask` rules still reach `canUseTool` in `bypassPermissions` mode; without a handler the turn blocks. The callback options type requires `toolUseID` and `requestId`.
- SDK 0.3.270 `Query.streamInput` keeps stdin open until the first result only when the query has "bidirectional needs" (canUseTool, hooks, SDK MCP servers). The runner does not rely on that internal: its input generator stays open until a result arrives, so permission responses and interrupts always have a channel.
- PreToolUse hook denies apply even in `bypassPermissions` (documented in "Configure permissions").
- Guard regexes: Windows switches like `/q` and `/s` look like MSYS drive roots (`/c`). Keep POSIX (`rm`) and Windows (`Remove-Item`/`rd`/`del`) target lists separate.
- In `SessionManager`, dequeuing the next turn must not wait for the disk flush; tests using microtask ticks exposed the hidden I/O dependency.
- grammY's built-in polling handles updates one at a time: a command handler that awaits a slow call (e.g. `Query.interrupt()`, which has no timeout) freezes the whole bot, including the next `/stop`. Start timers before awaiting, and never await the Claude process in a handler.
- A turn's `result` arrives before the CLI process exits; a `/stop` in that window must not discard the answer. The runner emits a `result` event so the manager can tell.
- Store flush errors must be cleared by a later successful write and failed writes retried; otherwise stale errors surface and state is silently lost on shutdown.
- PID lock files survive power loss and Windows reuses PIDs: treat a lock older than the last boot as stale.
- The SDK copies `process.env` into `claude.exe` and every child command; delete secrets (the bot token) from `process.env` after reading config.
- Live Telegram test (2026-09-14): the recovery notice promised "Your session is still there — send a message to continue", but `lastActivityAt` from before the crash made the next message expire the session. Recovery now restarts the idle clock.
- Telegram Web's command autocomplete sends `/history` when `/history all` is typed and Enter is pressed; the in-message toggle button is the reliable path to "all" mode.
- The SDK emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on every query; run node with `--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` to keep stderr clean (AskUserQuestion still reaches canUseTool — verified live).
- A chat's saved project folder can disappear (deleted/renamed test project). Starting Claude in a missing cwd fails; check it before each turn and fall back to PROJECTS_ROOT with a notice. Mark the chat as "starting" while those async checks run so a second message queues instead of starting a parallel turn.
- Plan limits: SDK 0.3.270 streams `rate_limit_event` (status allowed / allowed_warning / rejected, `resetsAt` in epoch seconds from the unified reset header, utilization possibly a 0–1 fraction). A limit stop also appears as assistant `error: 'rate_limit' | 'billing_error'` or result `terminal_reason: 'blocking_limit'`. Detect limits from these structured fields, never from the "You've hit your limit" text.
- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` works on a query whose input never yields: no prompt, no tokens, ~2 s. The real payload has many more keys than the typings (spend, seven_day_breakdown, codenamed windows); parse only the known windows with a permissive schema and keep the call isolated so a rename breaks only /usage.
- Async generators without `yield` trip eslint `require-yield`; an explicit `{ [Symbol.asyncIterator]: () => ({ next }) }` object is the clean way to build a held, empty prompt stream.
- Splitting an oversized paragraph at any whitespace cut lines mid-way; prefer newline boundaries, then spaces.
- `npm` allow-scripts blocked esbuild's postinstall, but tsx and vitest still work because the platform binary ships as an optional dependency.

## 2026-09-14 — agentpager core (provider interface, daemon, CLI)

- The Telegram Bot API cannot resolve a user by `@username` (`getChat @user` → "chat not found"). Whitelisting by username needs pairing: the first private message from a listed username binds its user id, and only the id is trusted afterwards.
- Tooling on this machine: Python reading a script from a Git Bash heredoc decodes it as cp1252 unless `PYTHONUTF8=1`, and backslash-heavy literals get mangled on the way. Use the Edit/Write tools (or a script file) for edits containing Windows paths or non-ASCII text.
- `@types/node` `ForkOptions` omits `windowsHide`, but `fork()` passes every option to `spawn()`; without it a hidden daemon can flash a console window when it forks the worker. Build the options as a variable to avoid the excess-property check.
- Windows PowerShell: pass scripts with `-EncodedCommand` (UTF-16LE base64) instead of `-Command` to avoid command-line quoting of paths; typographic quotes (’) also delimit single-quoted strings; output uses the console code page, so return ASCII markers/JSON and phrase messages in TypeScript.
- A daemon that stops on a fatal config error exits within milliseconds, before a 500 ms status poll sees it. The CLI reads the fatal message back from `supervisor.log` (filtered by start time) to explain a failed `start`.
- `tsx -e` compiles to CJS: no top-level await; wrap in an async IIFE.
- Test fakes whose `sleep` resolves as a microtask starve helpers based on timers (`setInterval(0)` never runs inside the polling loop); drive state changes from the fake itself.
- Piped stdin (a parent process or scripted answers): one readline interface per question reads the whole pipe and drops the rest when it closes. Use a single interface's async line iterator when stdin is not a TTY.
- Under fnm, `process.execPath` is inside a per-shell junction (`%LOCALAPPDATA%\fnm_multishells\<id>\node.exe`) that fnm cleans up later; thousands accumulate. Anything persisted for later launches (autostart task, LaunchAgent) must store `realpathSync(process.execPath)`. Found on the live install: the logon task pointed at such a junction.
- Live check 2026-09-14 (Windows): fresh `setup` → pairing on first message → Claude turn with session + cost → `/status`, `/model` (persisted), `/usage` all worked through the daemon/worker.

## 2026-09-14 — desktop app spike (sub-project B, Windows)

- Electron 44's `electron` package has no install script: the binary downloads on first use (`index.js`), so npm 11 `allow-scripts` does not block it. electron-builder downloads its own Electron zip for packaging.
- `fork()` from an Electron main process with `ELECTRON_RUN_AS_NODE=1` in the worker env runs the core worker as plain Node from `app.asar.unpacked`; `process.send` works (the packaged smoke gets the worker's fatal "no config" message).
- pino-roll transports run from the packaged app when `pino`, `pino-roll`, `thread-stream`, `pino-abstract-transport` and `sonic-boom` are in `asarUnpack`; the SDK's `claude.exe` is unpacked byte-identical with its Anthropic signature intact (electron-builder's "signing" line is a no-op without a certificate).
- npm workspaces: electron-builder copies the whole linked `packages/core` folder, not its `files`; exclude `src`, `tests` and config files in `electron-builder.yml`.
- The Windows IPC pipe was named only after the user, so a daemon with a temporary `AGENTPAGER_HOME` hit `EADDRINUSE` against the real bot and died before logging anything. Overridden homes now get their own pipe (hash of the folder), and `runDaemon` logs startup failures to `supervisor.log`, which is synchronous so `app.exit()` cannot drop the last lines.
- `--daemon` windowlessness is by construction (no `BrowserWindow`, GUI-subsystem exe, worker forked with `windowsHide`); confirm by eye in the live check.

## 2026-09-14 — desktop app implementation

- Testing Library only auto-unmounts when `afterEach` is a global; with vitest globals off, call `cleanup()` in the setup file or queries find elements from earlier tests.
- `@typescript-eslint/unbound-method` flags `expect(api.method)` when an interface declares methods; declare bridge members as function-typed properties instead.
- A `<form>` with `<input type="number" min="1">` never fires `submit` for `0` (native constraint validation, in jsdom and Chromium); use `noValidate` when the form shows its own messages.
- TypeScript keeps a `this.flag` narrowing across `await`; a re-check after an await (e.g. "stopped while starting") must go through a method call or lint calls it unnecessary.
- A GUI launched from a shell with `ELECTRON_RUN_AS_NODE` set (VS Code's terminal) would start `<exe> --daemon` as plain Node; the daemon spawn removes that variable.
- Electron's default `userData` would be `%APPDATA%\agentpager` — the bot's own app-data folder; the app moves Chromium's profile to `agentpager-desktop`.
- `nativeImage.createFromBitmap` expects the platform's pixel order; tray icons are generated as PNG (`zlib.deflateSync` + `zlib.crc32`) instead.

## 2026-09-14 — desktop live check (Windows)

- `electron-builder --dir` deletes the old unpacked build file by file. With the bot's `--daemon` running from it, it failed on `agentpager.exe` (EPERM) after deleting ICU data, paks and locales — a running bot on a half-deleted build, and an autostart task pointing at it. `npm run pack` now renames the folder and back first and refuses while anything runs from it. Check processes *and stop* before packing; a listing that shows processes is not a gate unless the script stops on it.
- A hidden checkbox with `position: absolute` and no positioned ancestor is placed against the window; focusing it scrolls the whole page even with `overflow: hidden`.
- A single-row CSS grid with an `auto` row grows with its content; use `grid-template-rows: minmax(0, 1fr)` so only the content column scrolls.
- Each Task Scheduler call through PowerShell costs about a second; never read the state back after a successful change, and never draw a switch as "off" while its state is still loading.
- In `--daemon` mode Chromium still starts GPU and network utility processes; `app.disableHardwareAcceleration()` removes the GPU one.
- Live result: GUI Stop/Start/Restart, autostart switch to the app, a Claude turn from the packaged daemon, bot answering with the window hidden and after quitting the app, single instance — all worked.

## 2026-09-15 — agentpager app releases (sub-project C)

- electron-updater's GitHub provider only reads tags of the form `v` + semver; monorepo-style tags such as `app-v0.1.0` are skipped. App releases use `vX.Y.Z`; the npm package never creates GitHub Releases.
- electron-builder NSIS: defining `customCheckAppRunning` also drops its own `!include "getProcessInfo.nsh"` and `Var pid`, so `_CHECK_APP_RUNNING` fails with `Invalid command: "${GetProcessInfo}"`; include both in `installer.nsh`. The default check kills everything running from `$INSTDIR` (including the bot), hence the graceful `--prepare-update` first.
- NSIS `deleteAppDataOnUninstall` removes `%APPDATA%\<productName>` — for agentpager that is the bot's own data folder shared with the cli. Keep it false and delete only `agentpager-desktop`.
- `--publish never` with a `publish` block still writes `latest.yml`, the blockmap and `resources/app-update.yml`.
- `@resvg/resvg-js` `render().pixels` are premultiplied RGBA (#ff8000 at 50% → [128, 64, 0, 128]); ICO bitmaps need straight alpha.
- `app.requestSingleInstanceLock(data)` delivers `data` to the running instance's `second-instance` on every attempt; a maintenance process can make the window quit and poll the lock until it is free.
- electron-updater's `AppUpdater.on` returns `this` (the whole updater), so a structural `Pick` does not accept test fakes; declare the used surface with method signatures.
- In this shell `npx tsx -e` hung; run one-off scripts as files. `node_modules/electron/dist` stays empty until something calls `require('electron')` (it downloads then).
- Test code appended with a Git Bash heredoc lost the doubled backslashes of Windows paths; write such content with the Write/Edit tools.
- A macOS app started from a `.dmg` or Downloads runs from a translocated read-only copy; a LaunchAgent pointing there breaks after reboot. The app offers to move itself to Applications and refuses autostart from `/Volumes/` or `/AppTranslocation/` paths; with `AGENTPAGER_HOME` set it never asks (smoke tests).
- A one-click per-user NSIS install is named after `package.json` `name` (sanitized), not `productName`: the workspace name `@agentpager/desktop` installed to `%LOCALAPPDATA%\Programs\@agentpagerdesktop` and the installer smoke found nothing. `extraMetadata.name: agentpager` fixes the folder, registry key and updater cache name. Found by the release dry run on CI.
- On Windows a process the app spawns (the bot daemon) inherits the app's stdio handles; Playwright's `ElectronApplication.close()` waits until those pipes close, so it hung for the whole test limit while the daemon kept running. Stop the daemon before closing the app in tests. Found by adding timestamped step logs and uploading the test `AGENTPAGER_HOME` logs: every product step had passed.
- Translating the UI: an accent-only search misses unaccented words (a "Xong" button survived); desktop tests also hard-coded core messages, so translate core first and update the app's copies of core wording in the same change.
