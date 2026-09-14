# claude-pager — Design Spec

Date: 2026-09-14
Status: Approved in chat, pending written-spec review

## 1. Purpose

Remote-control the Claude Code CLI installed on this Windows machine through a private Telegram bot,
for emergencies when the user is away from the computer. Claude runs with full permissions.

## 2. Requirements (from user)

| # | Requirement |
|---|---|
| R1 | Chat keeps the current Claude session (multi-turn context) |
| R2 | Session ends after 60 minutes without activity |
| R3 | `/new` starts a new session |
| R4 | `/history` lists previous sessions |
| R5 | `/resume` jumps back into a previous session |
| R6 | Claude has full permissions |
| R7 | `/stop` interrupts a running turn |
| R8 | `/project` picks the working directory with buttons |
| R9 | `/status` and `/model` |
| R10 | Send photos/files to Claude; Claude sends files back |
| R11 | Auto-start after the user logs in to Windows |
| R12 | Messages sent while Claude is running are queued |
| R13 | `/history all` also lists every session of the current project on the machine |
| R14 | Minimal hook-based block list for catastrophic commands |
| R15 | Only whitelisted Telegram users can use the bot |
| R16 | When Claude asks multiple-choice questions or needs an approval, the user answers with Telegram buttons |

Not requested (user declined): realtime progress streaming.

## 3. Stack

- Node.js 24, TypeScript, ESM. Build with `tsc` to `dist/`, dev with `tsx`.
- `grammy` — Telegram Bot API, long polling (no webhook, no inbound port).
- `@anthropic-ai/claude-agent-sdk` pinned exactly to `0.3.270` (0.x API may change).
  `pathToClaudeCodeExecutable` points at the locally installed `claude.exe`, so the user's
  existing login, settings, MCP servers and skills are used.
- `zod` — env/config validation.
- `marked` — Markdown lexer for rendering Claude output to Telegram HTML.
- `pino` + `pino-roll` — logs to stdout and `logs/` (daily rotation, keep 14 files).
- `vitest`, `eslint`, `typescript` — tests, lint, typecheck.

## 4. Configuration (`.env`, validated at startup; invalid config = exit with a clear error)

| Var | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | |
| `ALLOWED_USER_IDS` | yes | — | Comma-separated numeric Telegram user IDs, at least one |
| `CLAUDE_EXECUTABLE` | yes | — | Absolute path, must exist (e.g. `C:\Users\chien\.local\bin\claude.exe`) |
| `PROJECTS_ROOT` | no | `D:\Projects` | Must exist and be a directory |
| `IDLE_TIMEOUT_MINUTES` | no | `60` | Integer ≥ 1 |
| `DEFAULT_MODEL` | no | unset | Unset = CLI default. Allowed: `opus`, `sonnet`, `haiku` |
| `DEFAULT_EFFORT` | no | unset | Allowed: `low`, `medium`, `high`, `xhigh`, `max` |
| `DATA_DIR` | no | `./data` | State, uploads, lock file |
| `LOG_LEVEL` | no | `info` | |

`guard-rules.json` at the project root holds the block list (section 10).

## 5. Security

- **Whitelist middleware** runs first on every update (messages and callback queries). Updates from
  users not in `ALLOWED_USER_IDS`, or from non-private chats, get no reply; they are logged at `warn`
  with user id and username.
- **Single instance lock**: `DATA_DIR/bot.lock` holds the PID. On start, if the file exists and that
  PID is alive → exit with error "another instance is running". Stale lock (dead PID) → take over.
  Reason: two polling instances make Telegram return 409 and updates get split between them.
- `.env`, `data/`, `logs/` are git-ignored.
- README tells the user to enable Telegram two-step verification: a stolen Telegram account equals
  shell access to this machine.
- The guard hook (section 10) is a best-effort safety net, **not** a security boundary; README states this.

## 6. Architecture

```
src/
  index.ts                bootstrap: config → logger → lock → store → bot → shutdown handlers
  config.ts               zod env schema, guard-rules loading
  logger.ts               pino setup
  bot/
    bot.ts                grammy Bot construction, middleware order, setMyCommands
    auth.ts               whitelist middleware
    render.ts             Markdown → Telegram HTML + chunking
    format.ts             relative time, session list lines, status text (Vietnamese UI strings)
    commands/             one file per command: start, new, history, resume, project, stop, status, model
    handlers/
      message.ts          text messages → SessionManager.submit
      media.ts            photos/documents → download → SessionManager.submit
      callbacks.ts        inline button callbacks (history page, resume, project, model)
  claude/
    runner.ts             ClaudeRunner: wraps SDK query() for one turn; interface Runner
    tools.ts              in-process MCP server with send_file
    guard.ts              PreToolUse hook built from guard rules
    systemPrompt.ts       appended system prompt text
    prompts.ts            PromptBroker: canUseTool handler (AskUserQuestion + approvals), section 9.5
  sessions/
    manager.ts            SessionManager: per-chat state machine, queue, idle timer
    store.ts              JSON state persistence (atomic)
    history.ts            bot registry listing + listSessions() for "all" mode
  util/
    lock.ts               single-instance lock
scripts/
  run.ps1                 supervisor: runs node dist/index.js, restarts on non-zero exit with backoff
  install-task.ps1        registers the Task Scheduler task (user runs it, enters own password)
  uninstall-task.ps1
tests/                    vitest, mirrors src/
guard-rules.json
```

Dependency direction: `bot/*` → `sessions/*` → `claude/*` (via the `Runner` interface) → SDK.
`SessionManager` never imports grammy; it talks to the bot through a `Notifier` interface
(`sendText`, `sendFile`, `sendTyping`). This keeps the manager testable with fakes.

## 7. Session model

### 7.1 State (per chat; private chat id == user id)

```ts
interface ChatState {
  chatId: number;
  cwd: string;                  // current project dir, default PROJECTS_ROOT
  activeSessionId: string | null;
  lastActivityAt: number;       // epoch ms
  model: 'opus' | 'sonnet' | 'haiku' | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  runningSince: number | null;  // non-null while a turn runs; used for crash detection
  lastTurnCostUsd: number | null;
}
interface SessionRecord {        // registry of sessions created or resumed via the bot
  sessionId: string;
  chatId: number;
  cwd: string;
  title: string;                // first prompt, first 60 chars, newlines collapsed
  createdAt: number;
  lastActiveAt: number;
}
interface PersistedState { version: 1; chats: ChatState[]; sessions: SessionRecord[] }
```

Registry keeps the newest 200 records per chat; older ones are dropped from the registry only
(session files on disk are untouched).

### 7.2 Store

- `DATA_DIR/state.json`. Write = serialize → write `state.json.tmp` → `fs.rename` over `state.json`.
- Writes are serialized through a single promise chain (no interleaved writes).
- Missing file → empty state. Unparseable or schema-invalid file → rename to
  `state.json.corrupt-<timestamp>`, start empty, log `error`, and notify every allowed user on startup.

### 7.3 Turn lifecycle

One Telegram input = one turn = one `query()` call whose process exits when the turn ends.

1. `submit(chatId, input)`: if a turn is running → push to queue (section 7.5), reply
   "📥 Đã xếp hàng (vị trí N)". Otherwise start the turn.
2. Before starting: if `activeSessionId` is set and `now - lastActivityAt > idle timeout`, expire it
   first (section 7.4) — covers the window between timer ticks.
3. Set `runningSince = now`, persist, start typing indicator (`sendChatAction typing` every 4 s).
4. Call `query()` with options:
   - `cwd`, `pathToClaudeCodeExecutable`, `resume: activeSessionId ?? undefined`
   - `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`
   - `settingSources: ['user', 'project', 'local']` (loads CLAUDE.md, MCP servers, skills like the CLI)
   - `systemPrompt: { type: 'preset', preset: 'claude_code', append: <systemPrompt.ts> }`
   - `model`, `effort` when set
   - `mcpServers: { telegram: <send_file server bound to this chat> }`
   - `hooks: { PreToolUse: [<guard>] }`
   - `canUseTool`: the PromptBroker bound to this chat (section 9.5). The SDK emits process warning
     `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` because of `bypassPermissions`; this is expected (only
     interaction-required calls reach the callback) and is logged once at `info`
   - `abortController` owned by the runner
   - `prompt`: always an `AsyncIterable<SDKUserMessage>` yielding exactly one message (string content
     for text, image + text blocks for a photo). SDK 0.3.270 documents `interrupt()` as a control request
     that is only supported with streaming input, so a plain string prompt would break `/stop`.
5. Every SDK message updates `lastActivityAt` (in memory; persisted at turn end and on expiry).
   Tool-use blocks update `currentTool` (in memory, for `/status`).
6. `system/init` message → capture `session_id`. New session → create `SessionRecord`.
   Resumed session → update its `lastActiveAt` (create a record if resumed from `/history all`).
7. `result` message:
   - `subtype: 'success'` → render `result` text and send; store `total_cost_usd`.
   - error subtypes → send "❌ <subtype>" plus `errors` joined, if present.
   - turn was interrupted by `/stop` → send "⏹ Đã dừng."
8. Exception thrown from `query()` → send "❌ Lỗi: <message>", log with stack. `activeSessionId`
   is kept if it was captured.
9. Finally: stop typing, `runningSince = null`, persist, then dequeue next input if any.

### 7.4 Idle expiry (R2)

- A 60-second interval checks every chat: `activeSessionId != null && runningSince == null &&
  queue empty && now - lastActivityAt > IDLE_TIMEOUT_MINUTES`.
- On expiry: `activeSessionId = null`, persist, send
  "💤 Phiên đã kết thúc sau <IDLE_TIMEOUT_MINUTES> phút không hoạt động. Tin nhắn tiếp theo sẽ mở phiên mới. /resume để quay lại."
- A running turn is never expired, however long it runs; activity during a turn resets the clock.

### 7.5 Queue (R12)

- In-memory FIFO per chat, max 10 items. The 11th → reply "⚠️ Hàng đợi đầy (10). Dùng /stop hoặc đợi."
- Items run one by one in the same session after the current turn finishes.
- Queue is lost on bot restart (it is in memory); the crash-recovery notice (7.6) says so.
- While an interactive prompt (9.5) is waiting for a free-text answer, a plain text message is consumed
  as that answer instead of being queued. Photos/documents are still queued.

### 7.6 Crash / restart recovery

On startup, any chat with `runningSince != null` → set to null, persist, send
"⚠️ Bot vừa khởi động lại; lượt đang chạy từ <time> đã bị gián đoạn (hàng đợi cũng mất). Session vẫn còn — nhắn tiếp để tiếp tục."
The session is still resumable because Claude Code persisted it to disk.

## 8. Commands

UI strings are Vietnamese. `setMyCommands` registers all commands with descriptions at startup.
"Busy" means a turn is running for that chat.

| Command | Behaviour |
|---|---|
| `/start`, `/help` | Short usage guide, current project, allowed commands |
| `/new` | Busy → "Claude đang chạy, /stop trước". Else `activeSessionId = null`, reply "🆕 Tin nhắn tiếp theo sẽ mở phiên mới trong <project>" |
| `/history` | Bot registry for this chat, newest first, 10 per page. Line: `<title> · <project name> · <relative time>`. Each line has a resume button; prev/next buttons |
| `/history all` | `listSessions({ dir: cwd, limit: 10, offset })` for the current project. Title = `customTitle ?? summary`. Bot-owned sessions marked 🤖. Sessions with `lastModified` within the last 5 minutes that are not this chat's active session marked ⚠️ "có thể đang mở ở nơi khác" |
| `/resume` | No argument → same list as `/history`. `/resume <id or unique id prefix ≥ 8 chars>` → resume directly. Busy → refuse. Validation: `getSessionInfo(id)` must return a session; its `cwd` (or registry cwd) must exist. On success: `activeSessionId = id`, `cwd = session cwd`, `lastActivityAt = now`, reply "▶️ Đã vào lại: <title> (<project>)". Ambiguous prefix → list matches |
| `/project` | Busy → refuse. Buttons: `PROJECTS_ROOT` itself plus each direct subdirectory (skip names starting with `.` and `node_modules`), sorted by name, 2 per row. Selecting a project different from `cwd` ends the active session (`activeSessionId = null`) and replies with the new project |
| `/stop` | Not busy → "Không có gì đang chạy". Busy → resolve any pending prompt as deny ("User stopped the turn"), `interrupt()` on the running query, clear queue, reply "⏹ Đang dừng… (bỏ N tin trong hàng đợi)". If the turn has not finished 10 s after `interrupt()`, abort via `abortController` and report it |
| `/status` | Project, short session id (8 chars) or "chưa có", state (rảnh / đang chạy <elapsed>, tool hiện tại / ⏳ đang chờ bạn trả lời), queue length, idle time left, model/effort (or "mặc định"), last turn cost labelled "ước tính" |
| `/model` | Buttons: model row (`opus`, `sonnet`, `haiku`, `mặc định`) and effort row (`low`…`max`, `mặc định`). Applies from the next turn; persisted per chat |

Callback data (≤ 64 bytes): `h:<b|a>:<page>` (history bot/all), `r:<sessionId>`,
`p:<snapshotId>:<index>`, `m:<model>`, `e:<effort>`,
`q:<promptId>:<questionIndex>:<optionIndex|done|other>` (questions), `a:<promptId>:<y|n>` (approvals). Project buttons reference an in-memory
directory snapshot; a stale or unknown snapshot → "Danh sách đã cũ, gõ /project lại".
Every callback is answered (`answerCallbackQuery`) so the button spinner stops.

## 9. Media and output

### 9.1 Inbound (R10)

- Files are downloaded via `getFile` into `DATA_DIR/uploads/<yyyymmdd>/<timestamp>-<safe name>`.
  Bot API download limit is 20 MB; larger → reply "File quá 20MB, Telegram Bot API không tải được".
- **Photo** (Telegram-compressed JPEG): take the largest size, save it, send to Claude as an `image`
  content block (base64, `image/jpeg`) plus a text block: caption (or "(không có caption)") and
  "Ảnh đã lưu tại <absolute path>".
- **Document** (any type, including image files sent uncompressed): save it, send text:
  caption plus "File đính kèm đã lưu tại <absolute path>". Claude reads it with its own tools.

### 9.2 Outbound text

- `render.ts` lexes Markdown with `marked` and emits only Telegram-supported HTML:
  `b, i, s, u, code, pre (with language class), a, blockquote`. Headings → bold line.
  Lists → `•` / `1.` prefixes. Tables → `pre` block. All text is HTML-escaped.
- Chunking: max 4096 chars per message, split only at block boundaries; a single oversized code
  block is split into multiple `pre` blocks. Every chunk is independently tag-balanced.
- If a response renders to more than 4 chunks: send the first chunk, then the full raw Markdown
  as `response-<timestamp>.md` document with caption "Phản hồi dài — xem file".
- If Telegram rejects a chunk with a parse-entities error: resend that chunk as plain text and
  log `warn` with the offending HTML (this is a logged fallback, not a silent catch).
- Empty result text → "✅ Xong (không có nội dung trả lời)."

### 9.3 Outbound files — `send_file` tool

- In-process MCP server (`createSdkMcpServer` + `tool()`), name `telegram`, one tool
  `send_file({ path: string, caption?: string })`, bound to the chat of the current turn.
- `path` relative → resolved against the turn's `cwd`. Must exist and be a file.
- Size limit 50 MB (Bot API upload limit). `.png/.jpg/.jpeg/.webp` ≤ 10 MB → `sendPhoto`;
  everything else → `sendDocument`.
- Failures return `isError: true` with the reason so Claude can react; success returns "sent".

### 9.4 Appended system prompt

States: the user is controlling Claude Code remotely via Telegram from a phone, likely in an
emergency; keep replies concise and lead with the outcome; the user cannot see the terminal or
local files, so use `mcp__telegram__send_file` to deliver any file, screenshot or long log the user
needs; when a decision has a few clear options, prefer `AskUserQuestion` because it renders as tap-able
buttons on the phone.

### 9.5 Interactive prompts — PromptBroker (R16)

Per the SDK docs ("Configure permissions" → "How permissions are evaluated"), even in
`bypassPermissions` mode these calls fall through to `canUseTool`: `AskUserQuestion`; `rm`/`rmdir`
removals targeting a critical path; MCP tools marked `requiresUserInteraction`; connector tools an
organization set to `ask`; settings `ask` rules. Without a handler the turn cannot proceed, so the
broker handles all of them. The callback may stay pending; the turn counts as running meanwhile.

**`AskUserQuestion`** (1–4 questions, 2–4 options each; option previews are not enabled):
- Questions are shown one at a time, in order. Message: `❓ <header>` bold, the question, then each
  option as `• <label> — <description>`.
- Single-select: one button per option label + `✍️ Khác` button. Tap an option → answer recorded.
- Multi-select: option buttons toggle a `✅` prefix (message markup is edited in place) + `✔️ Xong`
  + `✍️ Khác`. `Xong` with nothing selected → callback alert "Chọn ít nhất 1 lựa chọn hoặc bấm Khác".
  Answer = selected labels joined with `", "`.
- `Khác` → bot replies "Gõ câu trả lời của bạn"; the next plain text message becomes the answer
  (the user's text, never the word "Khác"). A plain text message sent while a question is displayed
  is also taken as its free-text answer without tapping `Khác`.
- After each answer the question message is edited to `❓ <question>\n→ <answer>` with buttons removed.
- When all questions are answered → return
  `{ behavior: 'allow', updatedInput: { questions: input.questions, answers } }`, keys = question text.

**Approvals** (every other tool reaching the callback):
- Message: `🔐 Claude xin quyền: <options.title ?? toolName>`, `options.decisionReason` if present,
  and an input summary (`command` for Bash/PowerShell, `file_path` for file tools, otherwise JSON),
  truncated to 1500 chars. Buttons `✅ Cho phép` / `❌ Từ chối`.
- Allow → `{ behavior: 'allow', updatedInput: input }`. Deny → `{ behavior: 'deny', message: 'User denied this action via Telegram' }`.
- No "always allow" option (not requested; would persist rules into settings).

**Lifecycle rules (both kinds):**
- Timeout = `IDLE_TIMEOUT_MINUTES` without an answer → resolve
  `{ behavior: 'deny', message: 'The user did not respond in time. Do not assume an answer; stop and summarize where you are.' }`,
  edit the message to `⌛ Hết hạn — không có trả lời`.
- `options.signal` aborted (e.g. `/stop`, shutdown) → resolve deny, edit message to `⏹ Đã huỷ`.
- Buttons belonging to a prompt that is already resolved or unknown (e.g. after restart) →
  callback alert "Câu hỏi này đã hết hạn".
- Only one prompt can be pending per chat at a time (the CLI calls the callback sequentially within a
  turn); if a second arrives while one is pending, it waits in order behind it.

## 10. Guard hook (R14)

- `PreToolUse` hook with matcher `Bash|PowerShell`. It reads the command string from the tool input,
  tests it against `guard-rules.json`, and on match returns a deny decision with the rule's reason.
- Bot notifies the user: "🛡 Đã chặn lệnh: `<command>` — <reason>".
- `guard-rules.json`: `[{ "id": string, "pattern": string (JS regex source), "flags": "i", "reason": string }]`,
  validated with zod at startup (invalid regex = startup error).
- Default rules:
  1. `disk-format` — `format <drive>:`, `Format-Volume`, `diskpart`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`
  2. `recursive-delete-root` — recursive delete (`rm -r*`, `Remove-Item -Recurse`, `rd /s`, `rmdir /s`, `del /s`)
    whose target is `/`, `~`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`, a bare drive root (`C:\`, `D:\`), `C:\Windows`, or `C:\Users\<name>` itself
  3. `force-push-main` — `git push` with `--force`, `-f` or `--force-with-lease` targeting `main` or `master`
  4. `machine-power` — `shutdown`, `Restart-Computer`, `Stop-Computer` (power-off loses remote access)
  5. `kill-bot` — `taskkill ... node.exe` with `/F` or `/IM node.exe`, `Stop-Process -Name node` (would kill this bot)
- SDK docs state hooks run before the permission mode and "a hook deny applies even in
  `bypassPermissions` mode". Still verify on SDK 0.3.270 with a harmless matching command during the
  smoke test; if it is not honoured, stop and report — do not ship an ineffective guard.

## 11. Auto-start (R11)

- `scripts/run.ps1`: loop running `node dist/index.js` from the project dir. Exit code 0 → stop loop.
  Non-zero → log to `logs/supervisor.log`, wait with exponential backoff (5 s → max 5 min, reset after
  10 min of healthy uptime), restart. This is process supervision, not a race-condition workaround.
- `scripts/install-task.ps1` (user runs it in a normal PowerShell; no password needed): builds the
  project, then registers task `claude-pager` with trigger **AtLogOn** for the current user,
  principal = current user with `LogonType Interactive`, action `powershell -NoProfile
  -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts\run.ps1`, working dir = project root,
  settings: `ExecutionTimeLimit` unlimited, `StartWhenAvailable`, `AllowStartIfOnBatteries`,
  `DontStopIfGoingOnBatteries`, `MultipleInstances IgnoreNew`. Re-running the script replaces the task.
- `scripts/uninstall-task.ps1` unregisters it.
- Verification: sign out and sign back in, send a message from Telegram, confirm Claude answers.
- Known consequence (user accepted): after a reboot nobody has logged in to (e.g. Windows Update
  auto-restart), the bot stays offline until the user logs in. README suggests setting Windows Update
  active hours / restart notifications to reduce this.
- README notes: disable sleep/hibernate on AC power, otherwise the bot is offline while the PC sleeps.

## 12. Shutdown

SIGINT/SIGTERM: stop polling → `interrupt()` running turns (wait up to 10 s) → flush store → release
lock → exit 0.

## 13. Error handling rules

- No empty catches. Every caught error is either handled with a user-visible message, rethrown, or
  logged with context and a defined fallback (e.g. 9.2 plain-text resend).
- Telegram API errors when sending a reply are logged; they never crash the process.
- Unhandled rejections / uncaught exceptions are logged at `fatal` and the process exits non-zero
  so the supervisor restarts it.

## 14. Testing

Unit tests (vitest), no network, no real Claude:
- `config`: required vars, defaults, invalid values, non-existent paths.
- `auth`: allowed user passes; other user, group chat, callback from other user are dropped.
- `store`: round-trip, atomic write, corrupt file quarantined, serialized writes.
- `manager` (fake `Runner`, fake `Notifier`, fake timers): new session captures id; resume passes id;
  idle expiry after timeout; no expiry while running or while queue non-empty; activity resets clock;
  queue FIFO and cap; `/stop` interrupts and clears queue; `/new`, `/project`, `/resume` refused while
  busy; crash-recovery notice on startup.
- `render`: escaping, each supported construct, tables → pre, chunk boundaries, oversized code block
  split, every chunk tag-balanced, >4 chunks → file mode.
- `guard`: each default rule has matching and non-matching cases (e.g. `rm -rf ./dist` allowed,
  `git push --force origin feature-x` allowed).
- `history`: pagination, prefix resolution (unique / ambiguous / none), ⚠️ recent-modification marker.
- `tools`: send_file path resolution, missing file, size limits, photo vs document selection.
- `prompts` (fake Notifier, fake timers): single-select answer; multi-select toggle + Xong, Xong with
  nothing selected; Khác + free text; plain text taken as answer; multiple questions in order and
  answers keyed by question text; approval allow/deny; timeout → deny; abort signal → deny;
  stale callback → expired alert; second prompt waits behind the first.

Quality gate: `npm run check` = `tsc --noEmit` + `eslint` + `vitest run`, all green.

Manual smoke checklist (real bot, real Claude; run with user's go-ahead): text turn, multi-turn memory,
`/new`, `/history`, `/history all`, `/resume` by button and by prefix, `/project`, `/stop` mid-turn,
queued message, photo in, `send_file` out, long response file mode, guard block, idle expiry with
`IDLE_TIMEOUT_MINUTES=1`, non-whitelisted account ignored, bot restart mid-turn notice, auto-start after login,
a prompt that makes Claude call `AskUserQuestion` (single, multi, Khác), an approval prompt
triggered safely by a throwaway test project whose `.claude/settings.json` has
`"permissions": { "ask": ["Bash(echo approval-test*)"] }` — never by a real critical-path removal.

## 15. Project files

`README.md` (setup: BotFather token, getting your user id, `.env`, build, install task, security notes),
`.env.example`, `.gitignore`, `CLAUDE.md`, `lessons.md`, `guard-rules.json`.
