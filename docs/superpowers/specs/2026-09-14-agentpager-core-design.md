# agentpager core (sub-project A) — Design Spec

Date: 2026-09-14
Status: Design approved in chat; written spec pending user review
The existing bot behaviour (commands, prompts, limits, rendering, guard, recovery) stays unless changed here.

## 1. Context and goal

agentpager is a Telegram bot that remote-controls a local coding agent. The user wants:
a desktop app (sub-project B, Electron) and installers (sub-project C) for Windows and macOS, install/start
from both the app and a terminal, config via UI/wizard, whitelist by Telegram `@username`, and a pluggable
"brain" so other agent CLIs (Codex, Cursor, Claude API, …) can be added later.

Sub-project A delivers the shared core that B and C build on: naming, provider abstraction, app-data config,
username pairing, a background daemon controlled over IPC, a cross-platform CLI with autostart, npm packaging.

## 2. Decisions (from the user)

| # | Decision |
|---|---|
| D1 | Work order A → B → C, each with its own spec/plan. Interim headless launcher fix already shipped (commit 2546582). |
| D2 | Whitelist by `@username`; the first private message from a listed username binds its user ID; afterwards only the ID is trusted. |
| D3 | Config lives in `config.json` in the OS app-data directory, shared by app and CLI; token stored in that file. |
| D4 | Terminal channel is an npm package published publicly. |
| D5 | `start` runs in the background; `autostart on|off` registers login start (Windows Task Scheduler, macOS LaunchAgent). |
| D6 | Project named **agentpager** (published on npm as `@chiennguyen/agentpager` because npm rejects the unscoped name as too similar to `agent-pager`; GitHub `nguyenkechien/agentpager` free). CLI command `agentpager`. |
| D7 | The brain is a provider behind a capability-based interface. Only the `claude-code` provider is implemented in A. |

Non-goals for A: Electron UI (B), installers/signing (C), adapters for Codex/Cursor/Gemini/Claude API,
auto-update, localisation. Telegram-facing and CLI-facing strings stay Vietnamese.

## 3. Naming

- npm package `@chiennguyen/agentpager` (public scoped package, `publishConfig.access: public`) with `bin: { "agentpager": "dist/cli/main.js" }`; the command stays `agentpager`.
- App-data folder `agentpager`.
- Windows scheduled task name `agentpager`; macOS LaunchAgent label `io.github.nguyenkechien.agentpager`.
- Creating the GitHub repository and publishing to npm are outward-facing: they happen only after an
  explicit go-ahead from the user, with the user logged in (`npm adduser`, `gh auth login`).

## 4. Architecture

```
src/core/            bot core, provider-agnostic
  bot/               grammY wiring, commands, handlers, views, render, telegramIo, auth (pairing)
  sessions/          StateStore, SessionManager, history, limits
  prompts/           PromptBroker (askUser / requestApproval, Telegram buttons)
  guard/             GuardPolicy (rules + matching), default rules for Windows and macOS
  config/            config schema, ConfigStore (read/write app-data config.json)
  worker.ts          builds and runs the bot from ConfigStore + provider registry
src/providers/
  types.ts           AgentProvider, capabilities, TurnRequest/TurnSink/TurnEvent, UsageReport, SessionSource
  registry.ts        id → provider factory
  claude-code/       runner (SDK query), events mapping, canUseTool adapter, guard hook, send_file MCP,
                     history source, usage source, detect, models/efforts, system prompt
src/daemon/          supervisor (restarts worker), ipc server/client, daemon info file, spawn helpers
src/platform/        app-data paths, executable lookup, autostart/windows.ts, autostart/macos.ts
src/cli/             main.ts (argument parsing, no framework), commands/*, terminal prompts
```

Dependency rule: `cli` → `daemon`/`platform`/`core/config`; `daemon` → `core/worker`; `core` → `providers/types`
only (never a concrete provider); `providers/claude-code` → SDK + `providers/types` + `core` types it needs
(PromptBroker interface, GuardPolicy, FileSender). A test enforces that `src/core/**` does not import
`@anthropic-ai/claude-agent-sdk` or `src/providers/claude-code/**`.

## 5. Provider interface

```ts
export interface ProviderCapabilities {
  interrupt: 'native' | 'kill';               // 'kill': /stop aborts the process at once (no 10 s grace)
  approvals: boolean;                         // provider can ask for tool approval mid-turn
  askUser: boolean;                           // provider can ask multiple-choice questions mid-turn
  sessionListing: boolean;                    // provider lists all sessions for a directory
  commandGuard: boolean;                      // provider can deny shell commands before they run
  fileSendTool: boolean;                      // provider can expose a send_file tool to the agent
  imageInput: 'native' | 'path';              // 'path': photo is saved and its path passed as text
  usage: 'plan-limits' | 'tokens' | 'none';   // what fetchUsage/limit events can report
}

export interface ModelOption { id: string; label: string }

export interface Detection {
  executable: string | null;                  // null = use a bundled binary if the provider has one
  version: string | null;
  problems: string[];                         // human-readable, Vietnamese
}

export interface ProviderContext {              // no provider-specific fields in core types
  guard: GuardPolicy;                         // core rules; provider applies them when commandGuard
  fileSender: FileSender;                     // core Telegram file upload; used when fileSendTool
  prompts: InteractionBroker;                 // core askUser/requestApproval; used when approvals/askUser
  logger: Logger;
}

export interface AgentProvider {
  readonly id: string;                        // 'claude-code'
  readonly displayName: string;               // 'Claude Code'
  readonly capabilities: ProviderCapabilities;
  detect(settings: ProviderSettings): Promise<Detection>;
  models(): readonly ModelOption[];
  efforts(): readonly string[];
  startTurn(request: TurnRequest, sink: TurnSink): RunningTurn;
  sessions?: SessionSource;                   // present iff capabilities.sessionListing
  fetchUsage?(): Promise<UsageReport>;        // present iff capabilities.usage !== 'none'
}

export interface ProviderSettings { executable: string | null }
export type ProviderFactory = (settings: ProviderSettings, context: ProviderContext) => AgentProvider;
```

Turn types keep today's shapes, generalised:
- `TurnRequest { chatId, cwd, resumeSessionId, model: string | null, effort: string | null, input: TurnInput }`.
- `TurnEvent` = `session | activity | tool | result | rate_limit | api_retry | limit_error`, where
  `rate_limit.snapshot` becomes `{ status, windowKey, windowLabel, scope: 'global' | 'model', resetsAtMs,
  utilizationPercent, threshold }` — labels and scope are produced by the provider, so `LimitTracker` no
  longer contains Claude window names.
- `TurnSink { emit(event): void }`. Mid-turn interaction goes through `ProviderContext.prompts`:
  - `askUser(chatId, questions, signal) → Promise<{ answers: Record<string,string> } | { declined: string }>`
  - `requestApproval(chatId, { title, reason, summary }, signal) → Promise<{ allow: true } | { allow: false; message: string }>`
  PromptBroker implements these; its Telegram UI and texts are unchanged. The claude-code adapter maps
  `canUseTool` (`AskUserQuestion` → askUser, others → requestApproval) to SDK `PermissionResult`.

Core behaviour per capability (so a weaker provider degrades instead of failing):

| Capability false / reduced | Core behaviour |
|---|---|
| `approvals` | No approval prompts can appear; nothing else changes. |
| `askUser` | System prompt addition omits the AskUserQuestion hint. |
| `sessionListing` | `/history all` and its toggle button are hidden; `/resume <id>` resolves only bot-registry ids. |
| `commandGuard` | Worker logs a warning at start; `/status` shows `🛡 Guard: provider không hỗ trợ`; `setup` warns. |
| `fileSendTool` | System prompt addition omits send_file. |
| `imageInput: 'path'` | Photo saved; text `Ảnh đã lưu tại <path>` only, no image block. |
| `interrupt: 'kill'` | `/stop` calls `abort()` immediately and reports `⏹ Đã dừng.` |
| `usage: 'none'` | `/usage` replies `📊 Provider này không cung cấp thông tin usage.` |

Validation of the interface against a second real surface: Codex app-server offers resume, `thread/list`,
`turn/interrupt`, `requestApproval`, `requestUserInput`, rate limits; Cursor/Gemini CLIs offer resume,
models, bypass mode, MCP but no documented interrupt/approval/ask-user/usage. Both map onto the table above
without core changes (research notes, 2026-09-14).

### 5.1 claude-code provider
- Capabilities: all `true`, `interrupt: 'native'`, `imageInput: 'native'`, `usage: 'plan-limits'`.
- Models: `opus` "Opus", `sonnet` "Sonnet", `haiku` "Haiku". Efforts: `low, medium, high, xhigh, max`.
- Moves today's `src/claude/*` and `sessions/history.ts` SDK source and `claude/usage.ts` under
  `providers/claude-code/`, behaviour unchanged (streaming input kept open until result, bypassPermissions,
  settingSources user/project/local, PreToolUse guard hook, in-process MCP `telegram.send_file`,
  rate-limit/api-retry/limit-error mapping, experimental usage request).
- Window labels move here: `five_hour` "5 giờ", `seven_day`/`seven_day_overage_included` "7 ngày",
  `seven_day_opus` "7 ngày · Opus" (scope model), `seven_day_sonnet` "7 ngày · Sonnet" (scope model),
  `overage` "usage credits", unknown "hiện tại".
- `detect`: settings.executable (must exist) → `where claude` (Windows) / `which claude` (macOS) → common
  paths (`%USERPROFILE%\.local\bin\claude.exe`; `~/.local/bin/claude`, `/opt/homebrew/bin/claude`,
  `/usr/local/bin/claude`) → `null` meaning the SDK's bundled platform binary is used, with problem
  `Không tìm thấy Claude Code CLI; dùng bản đi kèm SDK — cần đăng nhập Claude (chạy "claude" một lần).`
  Version from `<exe> --version` with a 10 s timeout. A `.cmd`/`.ps1` shim found on PATH is skipped because
  the SDK spawns the path directly.

## 6. Config and data

App-data directory: Windows `%APPDATA%\agentpager`, macOS `~/Library/Application Support/agentpager`.
`AGENTPAGER_HOME` overrides it (tests, portable use). Contents:

```
config.json      settings (below)
state.json       chat state and session registry (existing StateStore format)
daemon.json      { pid, startedAt, ipc: { path }, token }   written by the running supervisor
bot.lock         single-instance lock (existing)
guard-rules.json optional override; absent → built-in defaults
uploads/         Telegram downloads
logs/            agentpager.N.log (worker, pino-roll daily, keep 14), supervisor.log
```

`config.json` (zod-validated; every issue reported at once):
```json
{
  "version": 1,
  "telegram": { "botToken": "123:abc" },
  "allowedUsers": [{ "username": "example_user", "userId": 123456789, "pairedAt": "2026-09-14T06:00:00.000Z" }],
  "projectsRoot": "D:\\Projects",
  "idleTimeoutMinutes": 60,
  "logLevel": "info",
  "agent": { "provider": "claude-code", "executable": null, "defaultModel": null, "defaultEffort": null }
}
```
- `username` stored lowercase without `@` (Telegram usernames are case-insensitive); `userId`/`pairedAt` null
  until paired. Every entry has a username.
- `defaultModel`/`defaultEffort` must be in the provider's lists; unknown provider id is an error listing
  known ids.
- Writes are atomic (tmp + rename) with a read-modify-write helper that re-reads the file first, so the CLI
  and the worker (pairing) do not overwrite each other's changes. On macOS the file mode is `0600`.
- Chat state `model`/`effort` become plain strings; values not offered by the current provider are ignored
  (treated as default) and shown as default in `/model`.

## 7. Username pairing (auth)

Order for every update (message or callback query), private chats only:
1. `from.id` equals a paired entry's `userId` → allowed.
2. Else `from.username` (lowercased) equals an entry with `userId: null` → pair: re-read config, set
   `userId`, `pairedAt`, write, allow, and send `✅ Đã ghép @<username> với agentpager.` before handling the
   update.
3. Else `from.username` matches an entry already paired to a different id → deny silently, log `warn`
   `username matches a paired user with a different id` (possible username transfer).
4. Else deny silently, log `warn`.
Group/channel chats are always denied. `users add` while the daemon runs notifies the worker over IPC
(`reload-users`); the worker re-reads `allowedUsers` without restarting.

## 8. Daemon and IPC

Processes: `agentpager daemon` = **supervisor**; it forks `worker` (Node `child_process.fork`) which runs the
bot. Supervisor restarts a worker that exits non-zero with backoff 5 s doubling to 300 s, reset after 600 s
of healthy uptime; exit code 0 ends the supervisor. The worker reports `{ type: 'ready', botUsername }` or
`{ type: 'fatal', message }` (e.g. invalid config) over the fork channel; a fatal config error stops the
supervisor instead of restart-looping.

IPC: Windows named pipe `\\.\pipe\agentpager-<username>`, macOS unix socket `<app-data>/agentpager.sock`.
Protocol: one JSON object per line. Request `{ id, token, cmd }`, response `{ id, ok, data?, error? }`.
`token` is a random 32-byte hex secret stored in `daemon.json` (per-user app-data), so other local users
cannot control the daemon. Commands:
- `ping` → `{ version }`
- `status` → `{ pid, startedAt, workerPid, workerState: 'starting'|'running'|'restarting'|'stopped',
  restarts, botUsername, provider, lastError }`
- `stop` → supervisor sends `shutdown` to the worker (existing graceful shutdown: stop polling, interrupt
  turns ≤ 10 s, flush, release lock), waits ≤ 20 s then kills it, removes `daemon.json`, exits 0.
- `restart` → same shutdown, then a fresh worker (config re-read).
- `reload-users` → forwarded to the worker.

## 9. CLI

`agentpager <command>`; output Vietnamese; exit code 0 on success, 1 on error. No CLI framework.

| Command | Behaviour |
|---|---|
| `setup` | Interactive wizard (node:readline). Steps: bot token (hidden input, verified with `getMe`, shows `@botname`) → usernames (comma-separated, `@` optional) → projects root (default: `D:\Projects` if it exists else home on Windows; `~/Projects` if it exists else home on macOS) → provider (only `claude-code` now) → executable detection result (Enter accepts, or type a path) → idle minutes (default 60) → writes config → offers `autostart on` → offers `start`. Existing config → asks before overwriting. |
| `start [--foreground]` | Running (IPC ping ok) → `agentpager đang chạy (pid …)`. Else spawn `process.execPath <cli> daemon` detached, `windowsHide: true`, stdio ignored, then wait ≤ 20 s for `status.workerState === 'running'` → `✅ agentpager đang chạy · bot @… · pid …`; fatal → print the error, exit 1. `--foreground` runs the supervisor in this process and mirrors logs to stdout; Ctrl+C stops gracefully. |
| `stop` | IPC `stop`; not running → `agentpager không chạy`. |
| `restart` | IPC `restart` if running, else `start`. |
| `status` | Daemon state, bot, provider + detected version, projects root, paired/pending users, autostart state, config and log paths. |
| `logs [-f] [-n <lines>]` | Last N (default 50) lines of the newest worker log, formatted `HH:mm:ss LEVEL message {extra}`; `-f` follows. |
| `autostart on|off|status` | See §10. |
| `config path` / `config show` / `config set <key> <value>` | Show path; print config with token masked (`123:ab…xyz`); set `telegram.botToken`, `projectsRoot`, `idleTimeoutMinutes`, `logLevel`, `agent.provider`, `agent.executable`, `agent.defaultModel`, `agent.defaultEffort` with validation; prints `Chạy "agentpager restart" để áp dụng.` when the daemon runs. |
| `users list|add <@u>|remove <@u>|unpair <@u>` | Manage `allowedUsers`; notifies a running daemon (`reload-users`). |
| `--version`, `help` | Version; usage text. |

## 10. Autostart

Target command in both cases: `<process.execPath> <absolute cli path> daemon` captured when `autostart on`
runs; `status` warns if either path no longer exists (e.g. Node upgraded via nvm).

- **Windows**: `schtasks`-free PowerShell `Register-ScheduledTask` (script passed to `powershell.exe -NoProfile
  -NonInteractive -EncodedCommand`, so command-line quoting cannot mangle paths) with task name `agentpager`,
  trigger AtLogOn for the current user (`[System.Security.Principal.WindowsIdentity]::GetCurrent().Name`),
  principal Interactive/Limited, action `conhost.exe --headless "<node>" "<cli>" daemon`, settings: no time
  limit, StartWhenAvailable, battery-safe, MultipleInstances IgnoreNew. The PowerShell script text is produced
  by a pure function (unit-tested) with every value escaped. `off` stops the task if running and unregisters it. `status` via
  `Get-ScheduledTask`.
- **macOS**: plist `~/Library/LaunchAgents/io.github.nguyenkechien.agentpager.plist` with `ProgramArguments`
  [node, cli, daemon], `RunAtLoad true`, `KeepAlive false` (the supervisor restarts the worker),
  `StandardOutPath`/`StandardErrorPath` `<app-data>/logs/launchd.log`; `on` = write plist (pure generator,
  unit-tested) + `launchctl bootout gui/<uid>/<label>` (ignore "not loaded") + `launchctl bootstrap
  gui/<uid> <plist>`; `off` = bootout + delete plist; `status` = `launchctl print gui/<uid>/<label>` exit code.

## 11. Guard rules

Default rules gain macOS patterns: `diskutil (eraseDisk|eraseVolume|partitionDisk|secureErase)`, recursive
delete of `/`, `~`, `$HOME`, `/Users/<name>`, `/System`, `/Applications`; `sudo (shutdown|halt|reboot)`,
`shutdown -h|-r`, `osascript … (shut down|restart)`; `pkill|killall … node` (existing). The rules file in
app-data, when present, replaces the defaults. Rule tests cover both platforms' commands on any OS.

## 12. npm packaging and CI

- `package.json`: `"name": "@chiennguyen/agentpager"`, `"publishConfig": { "access": "public" }`, `"bin"`, `"files": ["dist", "guard-rules.default.json",
  "README.md", "LICENSE"]`, `"engines": { "node": ">=24" }`, `"prepublishOnly": "npm run check && npm run
  build"`. License: MIT (to confirm with the user before publishing).
- `npm pack --dry-run` in the verification step must list no `.env`, `data/`, `logs/`, tests or sources.
- `.github/workflows/ci.yml`: matrix `windows-latest`, `macos-latest`, Node 24: `npm ci`, `npm run check`,
  `npm run build`, `npm pack --dry-run`. The workflow file is committed in A; the repository is created and
  pushed only with the user's go-ahead.

## 13. First installation

1. Before publishing: `npm run build`, and `node dist/cli/main.js` stands in for the global command. After
   publishing: `npm i -g @chiennguyen/agentpager`.
2. The user runs `agentpager setup` themselves (the bot token is typed by the user).
3. `agentpager autostart on`, then `agentpager start`.
4. Verify in Telegram by messaging the bot from each listed username (pairing).

## 14. Error handling

Existing rules apply (no swallowed errors, logged fallbacks). Additionally: CLI prints actionable
Vietnamese errors (config issues listed one per line, IPC timeouts name the log path); the supervisor
never restart-loops on configuration errors; IPC requests with a wrong token are rejected and logged.

## 15. Testing

Unit (vitest, all OS-independent via injected platform/env/exec functions):
- providers: capability degradation table with a fake provider (sessionListing/commandGuard/usage/askUser/
  interrupt 'kill'/imageInput 'path'); core never imports the SDK (import-boundary test); claude-code
  mapping tests moved from today's suites.
- config: schema, defaults, per-provider model/effort validation, atomic read-modify-write, masking.
- pairing: rules 1–4, group chats, callback queries, persistence, reload.
- platform: app-data paths per OS, executable lookup order (fake fs/exec), autostart generators (PowerShell
  script text, plist XML) including escaping of paths with spaces/quotes.
- daemon: IPC server/client round-trip over a temp pipe/socket, token rejection, supervisor restart backoff
  and fatal-stop with a fake worker, graceful stop timeout kill.
- cli: argument parsing, each command against fakes (IPC client, ConfigStore, autostart).
- existing suites keep passing after the move.

Live (Windows, this machine, real Telegram bot, with the user's go-ahead as before): fresh setup,
pairing via a username entry, start/status/logs/stop/restart, `start --foreground`, autostart on (verify
Task Scheduler action, sign-in simulated by `Start-ScheduledTask`), autostart off, a Claude turn, `/status`,
`/usage`. macOS: unit tests on GitHub Actions `macos-latest` once the repository exists; manual macOS
checklist (setup, start, autostart on/off after log out/in, a turn) documented for the user to run — not
verifiable from this machine.
