# claude-pager

Private Telegram bot that remote-controls the local Claude Code CLI via `@anthropic-ai/claude-agent-sdk`.

## Commands

- `npm run check` — tsc --noEmit + eslint + vitest (must be green before committing)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm run dev` — run from `src/` with tsx

## Architecture

- `src/index.ts` — bootstrap: config → logger → lock → store → io/broker/runner/manager → bot → shutdown
- `src/config.ts` — `.env` validation (collects every issue into one `ConfigError`) and `guard-rules.json` parsing
- `src/sessions/` — `StateStore` (atomic JSON), `SessionManager` (per-chat turn state machine, queue, idle expiry), `history` (listing + resume resolution)
- `src/claude/` — `SdkRunner` (one `query()` per turn, always streaming input so `interrupt()` works), `PromptBroker` (`canUseTool`: AskUserQuestion buttons + approvals), `guard` (PreToolUse deny hook), `tools` (in-process MCP `send_file`)
- `src/bot/` — grammY wiring: `auth` whitelist, `commands/`, `handlers/`, `views` (texts + keyboards), `telegramIo` (Notifier/PromptUi/FileSender over the Bot API), `render` (Markdown → Telegram HTML chunks)

Core logic talks to Telegram only through the `Notifier`, `PromptUi` and `FileSender` interfaces, and to the SDK only through `Runner`; tests use fakes for these.

## Rules

- Agent SDK is pinned to an exact version; read `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before using a new API.
- TypeScript must stay < 6.1 while typescript-eslint requires it.
- UI strings are Vietnamese; code comments are English.
- Spec: `docs/superpowers/specs/2026-09-14-claude-pager-design.md`; plan: `docs/superpowers/plans/2026-09-14-claude-pager.md`.
