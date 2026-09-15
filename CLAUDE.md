# agentpager

Telegram bot that remote-controls a local coding agent ("brain"). Claude Code (via `@anthropic-ai/claude-agent-sdk`) is the only provider today; the core is provider-agnostic so Codex/Cursor/Gemini can be added later.

npm workspaces: `packages/core` is the bot, daemon and CLI (published as `@chiennguyen/agentpager`, "agentpager cli"); `apps/desktop` is the Electron app ("agentpager app", sub-project B), released as installers from GitHub Releases (sub-project C).

## Commands

- `npm run check` (root) — build `packages/core`, then typecheck + eslint + vitest in every workspace (must be green before committing)
- `npm run build -w packages/core` / `npm run start -w packages/core` — compile the core to `packages/core/dist/` and run the CLI
- `npm run dev -w packages/core` — run the daemon in the foreground from `src/` with tsx
- `npm publish -w packages/core` — publish `@chiennguyen/agentpager` (the user runs it: npm 2FA)
- `npm run dist -w apps/desktop` — installer for this machine (NSIS `.exe` / `.dmg`, `--publish never`); `npm run icons -w apps/desktop` re-renders the committed icons from `build/icons/*.svg`
- Releases: tag `vX.Y.Z` = `apps/desktop/package.json` version → `.github/workflows/release.yml` builds, smoke-tests and uploads to a draft; the user publishes the draft

## Architecture (`packages/core`)

- `src/core/worker.ts` — `startWorker`: app-data config → logger → lock → guard rules (app-data override or `guard-rules.default.json`) → state → io/broker → provider (registry) → limits/manager → users → bot
- `src/core/config/` — `schema` (zod-validated config.json, every issue in one `ConfigError`), `store` (atomic read-modify-write), `allowedUsers` (username pairing)
- `src/providers/types.ts` — provider-neutral contracts: `AgentProvider`, `TurnRequest`/`TurnEvent`/`TurnOutcome`, `InteractionBroker`, `GuardPolicy`, `FileSender`, `SessionSource`, `UsageReport`, `ProviderCapabilities`
- `src/providers/registry.ts` — provider catalog (static, used by setup/validation) and `createProvider(id, settings, context)`
- `src/providers/claude-code/` — `runner` (one `query()` per turn, always streaming input so `interrupt()` works), `events` (SDK message → `TurnEvent`), `canUseTool` (AskUserQuestion + approvals → broker), `guardHook` (PreToolUse deny hook), `sendFileTool` (in-process MCP `send_file`), `history`, `usage`, `labels`, `detect`
- `src/core/sessions/` — `StateStore` (atomic JSON), `SessionManager` (per-chat turn state machine, queue, idle expiry, capability-aware stop), `LimitTracker`, `history` (listing + resume resolution)
- `src/core/prompts/broker.ts` — `PromptBroker`: Telegram buttons for questions and approvals
- `src/core/guard/policy.ts` — guard rule parsing and matching; `src/core/systemPrompt.ts` — capability-dependent system prompt
- `src/core/bot/` — grammY wiring: `auth` whitelist, `commands/`, `handlers/`, `views` (texts + keyboards), `telegramIo` (Notifier/PromptUi/FileSender over the Bot API), `render` (Markdown → Telegram HTML chunks)
- `src/platform/` — app-data `paths` per OS, `which`, `commandRunner`, `autostart/` (Task Scheduler via encoded PowerShell, LaunchAgent plist)
- `src/daemon/` — `main` (`runDaemon`: IPC server + `daemon.json` + supervisor), `supervisor` (forks the worker, restart backoff, fatal stop), `workerEntry` (forked process running `startWorker`), `ipc` (newline JSON over named pipe / unix socket with token), `daemonInfo`, `packageRoot`
- `src/cli/` — `main` (bin), `run` (`runCli` command table), `args`, `io` (readline prompts; one buffered reader when stdin is piped), `deps` (real wiring), `logFiles`, `commands/*`; tests drive `runCli` with fake io/deps

Paths above are relative to `packages/core`. `src/core/**` and `src/providers/types.ts` must never import the Agent SDK or `providers/claude-code` (enforced by `tests/providers/boundary.test.ts`). Features a provider lacks degrade through `ProviderCapabilities`; tests use `tests/support/fakeProvider.ts`.

## Architecture (`apps/desktop`)

- `src/main/index.ts` — `--daemon` → `runAppDaemon` (core `runDaemon`, worker forked with `ELECTRON_RUN_AS_NODE`); `--prepare-update` / `--uninstall-cleanup` → `maintenance/run` (called by `build/installer.nsh`); otherwise `startAppShell`
- `src/main/shell/` — `appShell` (wiring, window, tray, single instance, login item, crash handling, move to Applications), `trayModel`/`trayIcon` (generated PNGs per bar theme and status colour), `macLocation`, `desktopState` (`desktop.json`), `desktopLog`, `trustedUrl`
- `src/main/maintenance/` — `prepareUpdate`/`uninstallCleanup` (quit the window via the single-instance lock, stop a daemon started from this executable), `resumeMarker` (`update-resume.json`), `resumeAfterUpdate`
- `src/main/update/` — `UpdateService` (state for UI/tray; asks or waits while the core reports `activeTurns`/`queuedInputs`), `windowsSource` (electron-updater, never installs on quit), `macReleaseSource` (GitHub latest release + dmg per arch), `schedule`
- `src/main/services/` — `ConfigService`, `DaemonService` (`toDaemonView` badges), `AutostartService`, `AgentService`, `telegramCheck`, `results` (`ApiFailure` → `ApiError`, config issues → field errors)
- `src/main/ipc/` — `schemas` (zod argument tuples per channel), `handlers` (sender check, never throws across the bridge); `src/main/mainHandlers.ts` maps channels to services
- `src/main/live/` — `StatusPoller` (2 s, push on change), `watchConfig` (300 ms debounce), `LogStream`/`LogSubscriptions` (tail + 250 ms batches)
- `src/preload/index.ts` — `window.agentpager` (`AgentpagerApi` in `src/shared/api.ts`, channel names in `src/shared/channels.ts`)
- `src/renderer/` — React: `App` (wizard when no config, else sidebar), `screens/` (Status, Users, Settings, Log, `wizard/`), `hooks`, `components`
- `build/` — `icons/*.svg` sources and generated `icon.ico`/`icon-mac.png`, `installer.nsh` (NSIS hooks); `resources/tray/` generated tray PNGs; `scripts/` — `renderIcons`, `ensureReleaseFree`, `release/*` (tag, notes, draft asset checks)
- Tests: `tests/main` (node), `tests/renderer` (jsdom + Testing Library, `fakeApi.ts`), `tests/smoke` (Playwright on the `npm run pack` build, `AGENTPAGER_EXE` to target another build), `tests/installer` (`playwright.installer.config.ts`: NSIS install/update/uninstall on Windows CI only, dmg on macOS)

The app imports the core only through `@chiennguyen/agentpager/{config,control,daemon,platform,providers}`. Never run a test daemon without a temporary `AGENTPAGER_HOME`: the user's real bot runs on this machine.

## Rules

- Agent SDK is pinned to an exact version; read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before using a new API.
- TypeScript must stay < 6.1 while typescript-eslint requires it.
- UI strings are English and provider-neutral in `src/core` ("agent", not "Claude"); code comments are English.
- `nsis.deleteAppDataOnUninstall` must stay false: NSIS's app-data folder is `%APPDATA%\agentpager`, the bot's data shared with the cli.
- Specs: `docs/superpowers/specs/2026-09-14-agentpager-core-design.md`, `docs/superpowers/specs/2026-09-14-agentpager-desktop-design.md`, `docs/superpowers/specs/2026-09-15-agentpager-release-design.md`; plans: `docs/superpowers/plans/2026-09-14-agentpager-core.md`, `docs/superpowers/plans/2026-09-14-agentpager-desktop.md`, `docs/superpowers/plans/2026-09-15-agentpager-release.md`.
