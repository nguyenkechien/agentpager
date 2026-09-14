# agentpager

Telegram bot that remote-controls a local coding agent ("brain"). Claude Code (via `@anthropic-ai/claude-agent-sdk`) is the only provider today; the core is provider-agnostic so Codex/Cursor/Gemini can be added later.

## Commands

- `npm run check` — tsc --noEmit + eslint + vitest (must be green before committing)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm run dev` — run from `src/` with tsx

## Architecture

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

`src/core/**` and `src/providers/types.ts` must never import the Agent SDK or `providers/claude-code` (enforced by `tests/providers/boundary.test.ts`). Features a provider lacks degrade through `ProviderCapabilities`; tests use `tests/support/fakeProvider.ts`.

## Rules

- Agent SDK is pinned to an exact version; read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before using a new API.
- TypeScript must stay < 6.1 while typescript-eslint requires it.
- UI strings are Vietnamese and provider-neutral in `src/core` ("agent", not "Claude"); code comments are English.
- Spec: `docs/superpowers/specs/2026-09-14-agentpager-core-design.md`; plan: `docs/superpowers/plans/2026-09-14-agentpager-core.md`.
