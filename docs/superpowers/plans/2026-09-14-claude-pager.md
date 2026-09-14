# claude-pager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Executed inline by the session that wrote the spec; tasks pin interfaces and test cases, code is written test-first per task.

**Goal:** Private Telegram bot that drives the local Claude Code CLI with persistent, resumable sessions.

**Architecture:** grammY long-polling bot → `SessionManager` (per-chat state machine, queue, idle expiry, JSON store) → `Runner` interface → `SdkRunner` wrapping `@anthropic-ai/claude-agent-sdk` `query()` with the local `claude.exe`. Bot-facing I/O goes through `Notifier` / `PromptUi` / `FileSender` interfaces so core logic is unit-tested with fakes.

**Tech Stack:** Node 24, TypeScript 6.0.3 (typescript-eslint requires <6.1), ESM, grammy 1.46.0, @anthropic-ai/claude-agent-sdk 0.3.270 (+ peers @anthropic-ai/sdk, @modelcontextprotocol/sdk, zod 4), marked 18, pino 10 + pino-roll 4, vitest 5, eslint 10.

Spec: `docs/superpowers/specs/2026-09-14-claude-pager-design.md` (section numbers below refer to it).

## Global Constraints

- All dependency versions pinned exactly (`npm install -E`).
- Comments in English; Telegram UI strings in Vietnamese exactly as written in the spec.
- No `TODO`/`FIXME`, no `any`, no `@ts-ignore`, no `eslint-disable`, no empty `catch`.
- `.env` loaded with Node's built-in `process.loadEnvFile()` (no dotenv).
- Idle timeout default 60 min; queue cap 10; history page size 10; registry cap 200 per chat.
- Telegram limits: message 4096 chars, download 20 MB, upload 50 MB, photo 10 MB, callback data 64 bytes.
- Quality gate after every task: `npm run check` (tsc --noEmit + eslint + vitest) green before commit.

## File Map

```
src/index.ts                     bootstrap + shutdown (Task 12)
src/config.ts                    env + guard rules parsing (Task 1)
src/logger.ts                    pino (Task 1)
src/util/lock.ts                 single-instance lock (Task 3)
src/sessions/store.ts            JSON state (Task 2)
src/sessions/manager.ts          SessionManager (Task 9)
src/sessions/history.ts          history listing + resume resolution (Task 10)
src/claude/guard.ts              guard matching + PreToolUse hook (Task 4)
src/claude/prompts.ts            PromptBroker (Task 6)
src/claude/tools.ts              send_file delivery + MCP server (Task 7)
src/claude/systemPrompt.ts       appended prompt (Task 8)
src/claude/runner.ts             Runner interface + SdkRunner (Task 8)
src/bot/render.ts                Markdown → Telegram HTML chunks (Task 5)
src/bot/auth.ts                  whitelist middleware (Task 11)
src/bot/format.ts                Vietnamese text builders (Task 11)
src/bot/telegramIo.ts            Notifier/PromptUi/FileSender over bot.api (Task 11)
src/bot/media.ts                 Telegram file download (Task 11)
src/bot/commands/*.ts            start, new, history, resume, project, stop, status, model (Task 11)
src/bot/handlers/*.ts            message, media, callbacks (Task 11)
src/bot/bot.ts                   wiring (Task 11)
guard-rules.json                 (Task 4)
scripts/run.ps1, install-task.ps1, uninstall-task.ps1 (Task 13)
README.md, .env.example, CLAUDE.md, lessons.md (Task 14)
tests/**                         mirrors src
```

---

### Task 0: Scaffolding (done before plan)

- [x] package.json (ESM, scripts dev/build/start/typecheck/lint/test/check), tsconfig.json (strict, NodeNext, noUncheckedIndexedAccess, verbatimModuleSyntax), tsconfig.build.json, eslint.config.js (strictTypeChecked), .gitignore, dependencies installed.
- [ ] Add `vitest.config.ts` (`test.include: ['tests/**/*.test.ts']`, `environment: 'node'`), verify `npx vitest run --passWithNoTests` works (esbuild postinstall was not approved by npm allow-scripts; confirm tsx/vitest still run).
- [ ] Commit `chore: scaffold project`.

### Task 1: Config + logger

**Files:** Create `src/config.ts`, `src/logger.ts`; Test `tests/config.test.ts`

**Produces:**
```ts
export type ModelAlias = 'opus' | 'sonnet' | 'haiku';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const MODEL_ALIASES: readonly ModelAlias[];
export const EFFORTS: readonly Effort[];
export interface GuardRule { id: string; pattern: RegExp; reason: string }
export interface AppConfig {
  telegramBotToken: string; allowedUserIds: ReadonlySet<number>; claudeExecutable: string;
  projectsRoot: string; idleTimeoutMs: number; defaultModel: ModelAlias | null;
  defaultEffort: Effort | null; dataDir: string; logLevel: string; projectDir: string;
}
export class ConfigError extends Error { readonly issues: string[] }
export function parseConfig(env: Record<string, string | undefined>, projectDir: string): AppConfig;
export function parseGuardRules(json: string): GuardRule[];   // throws ConfigError
export function createLogger(level: string, logDir: string): pino.Logger;   // logger.ts
```

Tests (`tests/config.test.ts`, uses a temp dir with a fake exe file):
- valid minimal env (PROJECTS_ROOT pointed at a temp dir) → idle 3_600_000 ms, model/effort null, dataDir resolved against projectDir; exported constant `DEFAULT_PROJECTS_ROOT === 'D:\\Projects'` is used when PROJECTS_ROOT is absent.
- missing TELEGRAM_BOT_TOKEN / ALLOWED_USER_IDS / CLAUDE_EXECUTABLE → ConfigError listing each.
- ALLOWED_USER_IDS `"1, 2"` → Set{1,2}; `"abc"` and `""` → error.
- CLAUDE_EXECUTABLE relative or non-existent → error; PROJECTS_ROOT not a directory → error.
- IDLE_TIMEOUT_MINUTES `0`, `-1`, `1.5` → error; DEFAULT_MODEL `gpt` → error; DEFAULT_EFFORT `ultra` → error.
- parseGuardRules: valid rules compile with flags; invalid regex → ConfigError naming rule id; missing fields → error.

Logger: pino with `transport.targets` = `pino/file` destination 1 (stdout) + `pino-roll` `{ file: join(logDir,'claude-pager'), frequency: 'daily', extension: '.log', limit: { count: 14 }, mkdir: true }`. No unit test (thin wiring); exercised in smoke test.

- [ ] Write failing tests → run `npx vitest run tests/config.test.ts` (FAIL) → implement → PASS → `npm run check` → commit `feat: config parsing and logger`.

### Task 2: State store

**Files:** Create `src/sessions/store.ts`; Test `tests/sessions/store.test.ts`

**Produces:**
```ts
export interface ChatState { chatId: number; cwd: string; activeSessionId: string | null; lastActivityAt: number;
  model: ModelAlias | null; effort: Effort | null; runningSince: number | null; lastTurnCostUsd: number | null }
export interface SessionRecord { sessionId: string; chatId: number; cwd: string; title: string; createdAt: number; lastActiveAt: number }
export interface ChatDefaults { cwd: string; model: ModelAlias | null; effort: Effort | null }
export const REGISTRY_CAP_PER_CHAT = 200;
export class StateStore {
  static open(filePath: string, defaults: ChatDefaults, now: () => number): Promise<{ store: StateStore; quarantinedPath: string | null }>;
  getChat(chatId: number): ChatState;                      // creates with defaults if absent (not persisted until updated)
  allChats(): ChatState[];
  updateChat(chatId: number, patch: Partial<Omit<ChatState, 'chatId'>>): ChatState;   // schedules write
  upsertSession(record: SessionRecord): void;              // schedules write, enforces cap (drops oldest lastActiveAt)
  sessionsForChat(chatId: number): SessionRecord[];        // newest lastActiveAt first
  findSession(sessionId: string): SessionRecord | undefined;
  flush(): Promise<void>;                                  // resolves after all scheduled writes land
}
```
Persisted shape `{ version: 1, chats, sessions }`, validated with zod. Write: `writeFile(tmp)` then `rename(tmp, file)`, chained on one promise so writes never interleave; a failed write rejects `flush()` and is logged by the caller.

Tests: missing file → empty; round-trip after `flush()` via reopening; `getChat` defaults; corrupt JSON → file renamed to `state.json.corrupt-<ts>`, `quarantinedPath` returned, store empty; schema-invalid JSON → same; 5 rapid `updateChat` then `flush` → final file has last values and no `.tmp` left; cap: 201 sessions → 200 kept, oldest dropped; `sessionsForChat` ordering and chat isolation.

- [ ] failing tests → implement → PASS → check → commit `feat: atomic JSON state store`.

### Task 3: Single-instance lock

**Files:** Create `src/util/lock.ts`; Test `tests/util/lock.test.ts`

**Produces:**
```ts
export class LockHeldError extends Error { readonly pid: number }
export function acquireLock(filePath: string, pid?: number): Promise<{ release(): Promise<void> }>;
export function isPidAlive(pid: number): boolean;   // process.kill(pid, 0); ESRCH → false; EPERM → true
```
Create with `open(file, 'wx')`; on EEXIST read PID: alive → throw LockHeldError; dead/unparseable → overwrite with own PID.

Tests: acquire on empty → file contains pid; second acquire while held by `process.pid` → LockHeldError; stale pid (spawn `node -e ""`, wait exit, use its pid) → takeover; garbage content → takeover; release removes file.

- [ ] failing tests → implement → PASS → check → commit `feat: single-instance lock`.

### Task 4: Guard rules + PreToolUse hook

**Files:** Create `guard-rules.json`, `src/claude/guard.ts`; Test `tests/claude/guard.test.ts`

**Produces:**
```ts
export function matchGuard(command: string, rules: readonly GuardRule[]): GuardRule | null;
export function createGuardHook(rules: readonly GuardRule[], onBlock: (command: string, rule: GuardRule) => void): HookCallbackMatcher;
```
Hook: `matcher: 'Bash|PowerShell'`; reads `input.tool_input.command` when `hook_event_name === 'PreToolUse'` and command is a string; match → `onBlock` + return `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by claude-pager guard (<id>): <reason>' } }`; otherwise `{ continue: true }`.

`guard-rules.json` (JS regex sources, flag `i`):
```json
[
  { "id": "disk-format", "reason": "Formatting or repartitioning disks is irreversible",
    "pattern": "(^|[\\s;&|(])(format(\\.com)?\\s+[a-z]:|format-volume\\b|diskpart\\b|clear-disk\\b|initialize-disk\\b|remove-partition\\b)" },
  { "id": "recursive-delete-root", "reason": "Recursive delete of a drive root, home directory or Windows directory",
    "pattern": "(\\brm\\s+(-[a-z]*r[a-z]*|--recursive)(\\s+-[a-z-]+)*|\\bremove-item\\b[^;&|\\n]*-recurse|\\b(rd|rmdir)\\s+/s|\\bdel\\s+(/[a-z]\\s+)*/s)[^;&|\\n]*?\\s[\"']?(/|~|\\$home|%userprofile%|\\$env:userprofile|[a-z]:[\\\\/]?|[a-z]:[\\\\/]windows|[a-z]:[\\\\/]users[\\\\/][^\\\\/\\s\"']+|/c/users/[^/\\s\"']+|/[a-z])[\\\\/]?[\"']?(\\s|$|[;&|])" },
  { "id": "force-push-main", "reason": "Force push to main/master rewrites shared history",
    "pattern": "\\bgit\\s+push\\b(?=[^;&|\\n]*\\s(--force(-with-lease)?|-f)\\b)(?=[^;&|\\n]*\\b(main|master)\\b)" },
  { "id": "machine-power", "reason": "Shutting down or restarting the machine cuts off remote access",
    "pattern": "(^|[\\s;&|(])(shutdown(\\.exe)?(\\s|$)|restart-computer\\b|stop-computer\\b)" },
  { "id": "kill-bot", "reason": "Killing node processes would kill claude-pager itself",
    "pattern": "(\\btaskkill\\b[^;&|\\n]*\\bnode(\\.exe)?\\b|\\bstop-process\\b[^;&|\\n]*-name\\s+[\"']?node\\b|\\b(pkill|killall)\\s+(-9\\s+)?node\\b)" }
]
```

Tests (table-driven, every rule both ways) — blocked: `format D:`, `Format-Volume -DriveLetter D`, `diskpart /s x.txt`, `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`, `rm -fr C:\\`, `rm -rf /c/Users/chien`, `Remove-Item -Recurse -Force C:\\Users\\chien`, `Remove-Item C:\\ -Recurse`, `rd /s /q D:\\`, `rmdir /s C:\\Windows`, `del /f /s C:\\`, `git push --force origin main`, `git push -f origin master`, `git push origin main --force-with-lease`, `shutdown /r /t 0`, `Restart-Computer`, `taskkill /F /IM node.exe`, `Stop-Process -Name node`. Allowed: `rm -rf ./dist`, `rm -rf node_modules`, `Remove-Item -Recurse .\\build`, `rd /s /q D:\\Projects\\tmp`, `git push --force origin feature-x`, `git push origin main`, `npm run format`, `taskkill /IM chrome.exe`, `Get-Process node`. Hook tests: deny output shape for blocked Bash command; `{continue:true}` for allowed; non-string command → continue; onBlock called once.

Known, accepted false positive pinned by a test: `echo shutdown later` is blocked (the guard is a coarse safety net, spec section 5). Rule regexes are adjusted until the table passes; the table is the contract.

- [ ] failing tests → implement → PASS → check → commit `feat: guard rules and PreToolUse hook`.

### Task 5: Markdown → Telegram HTML

**Files:** Create `src/bot/render.ts`; Test `tests/bot/render.test.ts`

**Produces:**
```ts
export const TELEGRAM_TEXT_LIMIT = 4096;
export function escapeHtml(text: string): string;                  // & < > "
export function renderBlocks(markdown: string): string[];          // one HTML string per top-level block
export function chunkBlocks(blocks: readonly string[], limit?: number): string[];
export function markdownToTelegramChunks(markdown: string, limit?: number): string[];
```
Rules (spec 9.2): `marked.lexer`; inline: strong→`<b>`, em→`<i>`, del→`<s>`, codespan→`<code>`, link→`<a href>` (href escaped), br→`\n`, text/escape→escaped, image→`<a href>text</a>`, html token→escaped raw. Blocks: paragraph; heading→`<b>…</b>`; code→`<pre><code class="language-x">…</code></pre>`; blockquote→`<blockquote>…</blockquote>`; list→lines `• ` / `n. `, nested lists indented by 2 spaces per level, task items `☐`/`☑`; table→`<pre>` with columns padded to max width, `|` separators; hr→`──────────`; space→skipped. Blocks joined with `\n\n`.
Chunking: pack blocks greedily with `\n\n` separators ≤ limit. A block longer than limit: if it is a `<pre>` code block → split code text by lines into several `<pre><code>` blocks each ≤ limit (a single line longer than limit is hard-split); otherwise → strip to plain text (render inline as escaped text only) and split at newline/space boundaries ≤ limit, never inside an HTML entity.

Tests: escaping `<script>&` ; bold/italic/strike/code/link; heading; fenced code with lang; nested list with numbers; task list; table alignment; blockquote; `chunkBlocks` packs and respects limit; long code block (limit 200) splits into multiple balanced `<pre>` chunks whose concatenated code equals original; long paragraph split never breaks `&amp;`; property: every chunk ≤ limit and has balanced tags (simple stack check helper in test) for a mixed 20k-char document.

- [ ] failing tests → implement → PASS → check → commit `feat: markdown to Telegram HTML renderer`.

### Task 6: PromptBroker

**Files:** Create `src/claude/prompts.ts`; Test `tests/claude/prompts.test.ts`

**Consumes:** `CanUseTool`, `PermissionResult` from the SDK; `escapeHtml` (Task 5).
**Produces:**
```ts
export interface Button { text: string; data: string }
export interface PromptUi {
  sendPrompt(chatId: number, html: string, keyboard: Button[][]): Promise<number>;
  editPrompt(chatId: number, messageId: number, html: string, keyboard: Button[][] | null): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
}
export interface CallbackOutcome { alert: string | null }
export class PromptBroker {
  constructor(ui: PromptUi, options: { timeoutMs: number; logger: Logger; newId?: () => string });
  canUseToolFor(chatId: number): CanUseTool;
  handleCallback(chatId: number, data: string): Promise<CallbackOutcome>;   // data 'q:…' | 'a:…'
  consumeText(chatId: number, text: string): Promise<boolean>;
  hasPending(chatId: number): boolean;
  cancelPending(chatId: number): void;   // resolves current + waiting prompts as deny 'User stopped the turn'
}
```
Behaviour exactly per spec 9.5 (texts: `❓`, `✍️ Khác`, `✔️ Xong`, `✅ ` prefix, `Gõ câu trả lời của bạn`, `Chọn ít nhất 1 lựa chọn hoặc bấm Khác`, `🔐 Claude xin quyền: `, `✅ Cho phép`, `❌ Từ chối`, `⌛ Hết hạn — không có trả lời`, `⏹ Đã huỷ`, `Câu hỏi này đã hết hạn`). Input for AskUserQuestion validated with zod (questions 1–4, options 2–4); invalid input → deny with message `Invalid AskUserQuestion input`. Prompts per chat serialized: a second `canUseTool` call awaits the first. Timer per prompt (timeoutMs), cleared on resolve. `options.signal` abort → resolve deny, edit `⏹ Đã huỷ`.

Tests (fake UI recording calls, `vi.useFakeTimers()`): single-select tap → allow with `answers[q]=label`, message edited with `→ label` and keyboard null; multi-select toggle A, B, untoggle A, Xong → `"B"`; Xong with none → alert, still pending; Khác then text → answer is text; plain text without Khác → answer; two questions answered in order → both keys; approval y → allow updatedInput === input; approval n → deny message; Bash approval summary shows command; timeout → deny + `⌛` edit; abort signal → deny + `⏹` edit; stale callback (unknown id) → alert `Câu hỏi này đã hết hạn`; second canUseTool waits until first resolves (second prompt not sent before); `cancelPending` resolves current and queued; `consumeText` false when nothing pending or pending approval (approvals don't take text).

- [ ] failing tests → implement → PASS → check → commit `feat: interactive prompt broker`.

### Task 7: send_file delivery + MCP server

**Files:** Create `src/claude/tools.ts`; Test `tests/claude/tools.test.ts`

**Produces:**
```ts
export interface FileSender {
  sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
  sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
}
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export type DeliveryResult = { ok: true; kind: 'photo' | 'document'; path: string } | { ok: false; error: string };
export function deliverFile(sender: FileSender, chatId: number, cwd: string, rawPath: string, caption?: string): Promise<DeliveryResult>;
export function createTelegramMcpServer(sender: FileSender, chatId: number, cwd: string): McpSdkServerConfigWithInstance;
```
MCP: `createSdkMcpServer({ name: 'telegram', version: '1.0.0', tools: [tool('send_file', …, { path: z.string().min(1), caption: z.string().max(1024).optional() }, handler)] })`; handler returns `{ content: [{ type: 'text', text: 'sent <kind>: <path>' }] }` or `{ content: [{ type:'text', text: error }], isError: true }`. Sender exceptions become `{ ok:false, error: 'Telegram upload failed: <message>' }`.

Tests (temp files, fake sender): relative path resolved against cwd; absolute kept; missing → error; directory → error; 51 MB sparse file (`truncate` via `fs.truncate`) → error; `.png` 1 KB → photo; `.png` 11 MB → document; `.txt` → document; sender throws → error result.

- [ ] failing tests → implement → PASS → check → commit `feat: send_file tool`.

### Task 8: Runner

**Files:** Create `src/claude/systemPrompt.ts`, `src/claude/runner.ts`; Test `tests/claude/runner.test.ts`

**Produces:**
```ts
export type TurnInput = { kind: 'text'; text: string } | { kind: 'photo'; imageBase64: string; mediaType: 'image/jpeg'; text: string };
export interface TurnRequest { chatId: number; cwd: string; resumeSessionId: string | null; model: ModelAlias | null; effort: Effort | null; input: TurnInput }
export type TurnEvent = { type: 'session'; sessionId: string } | { type: 'activity' } | { type: 'tool'; name: string };
export type TurnOutcome = { kind: 'success'; text: string; costUsd: number } | { kind: 'error'; subtype: string; errors: string[]; costUsd: number };
export interface RunningTurn { interrupt(): Promise<void>; abort(): void; readonly done: Promise<TurnOutcome> }
export interface Runner { start(request: TurnRequest, onEvent: (event: TurnEvent) => void): RunningTurn }
export function eventsFromMessage(message: SDKMessage): TurnEvent[];          // pure
export function outcomeFromMessage(message: SDKMessage): TurnOutcome | null;   // pure
export function buildUserMessage(input: TurnInput): SDKUserMessage;           // pure
export class SdkRunner implements Runner {
  constructor(deps: { claudeExecutable: string; broker: PromptBroker; fileSender: FileSender; guardRules: readonly GuardRule[];
    onGuardBlock: (chatId: number, command: string, rule: GuardRule) => void; logger: Logger });
}
export const SYSTEM_PROMPT_APPEND: string;   // systemPrompt.ts, spec 9.4
```
`SdkRunner.start` calls `query({ prompt, options })` with the options list from spec 7.3 step 4 (`settingSources: ['user','project','local']`, `systemPrompt: { type:'preset', preset:'claude_code', append }`, `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`, `pathToClaudeCodeExecutable`, `cwd`, `resume`, `model`, `effort`, `abortController`, `canUseTool: broker.canUseToolFor(chatId)`, `mcpServers: { telegram }`, `hooks: { PreToolUse: [guardHook] }`). Text input → prompt string; photo → async iterable yielding `buildUserMessage`. `done` iterates messages: every message → `onEvent` for `eventsFromMessage`; first `result` → outcome; stream ends without result → rejects `Error('Claude ended without a result')`. `interrupt()` → `query.interrupt()`; `abort()` → `abortController.abort()`.
`eventsFromMessage`: `system/init` → session (+activity); assistant message → activity + one `tool` event per `tool_use` block (name); any other → activity.

Tests (pure functions): init → session event; assistant with text+tool_use blocks → activity + tool; result success → success outcome with cost; result error → error outcome with errors; non-result → null; buildUserMessage photo → content `[image base64 block, text block]`, `parent_tool_use_id: null`. SdkRunner itself is covered by the smoke test (it only wires the SDK).

- [ ] failing tests → implement → PASS → check → commit `feat: Claude SDK runner`.

### Task 9: SessionManager

**Files:** Create `src/sessions/manager.ts`; Test `tests/sessions/manager.test.ts`

**Consumes:** `StateStore` (Task 2), `Runner`/`TurnInput`/`TurnOutcome` (Task 8), `PromptBroker.hasPending/cancelPending` (Task 6).
**Produces:**
```ts
export interface Notifier {
  sendMarkdown(chatId: number, markdown: string): Promise<void>;
  sendNotice(chatId: number, text: string): Promise<void>;
  setTyping(chatId: number, active: boolean): void;
}
export const QUEUE_CAP = 10;
export type SubmitResult = { kind: 'started' } | { kind: 'queued'; position: number } | { kind: 'queue_full' };
export type BusyResult = 'ok' | 'busy';
export interface StatusSnapshot { cwd: string; sessionId: string | null; runningSinceMs: number | null; currentTool: string | null;
  waitingForUser: boolean; queueLength: number; idleRemainingMs: number | null; model: ModelAlias | null; effort: Effort | null; lastTurnCostUsd: number | null }
export class SessionManager {
  constructor(deps: { store: StateStore; runner: Runner; notifier: Notifier; broker: Pick<PromptBroker, 'hasPending' | 'cancelPending'>;
    idleTimeoutMs: number; now: () => number; logger: Logger; stopGraceMs?: number /* default 10_000 */ });
  recoverAfterRestart(): Promise<void>;
  startIdleTimer(intervalMs?: number): void; stopIdleTimer(): void; checkIdle(): Promise<void>;
  submit(chatId: number, input: TurnInput, title: string): Promise<SubmitResult>;
  isBusy(chatId: number): boolean;
  newSession(chatId: number): BusyResult;
  resume(chatId: number, target: { sessionId: string; cwd: string; title: string }): BusyResult;
  setProject(chatId: number, cwd: string): BusyResult | 'unchanged';
  setModel(chatId: number, model: ModelAlias | null): void;
  setEffort(chatId: number, effort: Effort | null): void;
  stop(chatId: number): Promise<{ kind: 'idle' } | { kind: 'stopping'; dropped: number }>;
  status(chatId: number): StatusSnapshot;
  shutdown(): Promise<void>;   // stop idle timer, interrupt all running turns (wait stopGraceMs), flush store
}
```
Behaviour per spec 7.3–7.6 and section 8. `submit` returns `started` after kicking off the turn (does not await completion); turn completion drains queue. Outcome messages: success → `sendMarkdown(text || '✅ Xong (không có nội dung trả lời).')`; stopped turn → `sendNotice('⏹ Đã dừng.')`; error → `sendNotice('❌ <subtype>' + errors)`; thrown → `sendNotice('❌ Lỗi: <message>')`. `stop`: `broker.cancelPending`, clear queue, `turn.interrupt()`, after `stopGraceMs` still running → `turn.abort()` + notice `⚠️ Không dừng được sau 10 giây — đã huỷ tiến trình.`. Title for a new session record = first 60 chars of `title` with whitespace collapsed.

Tests (FakeRunner with controllable deferred outcome + recorded requests, fake notifier, real StateStore on temp file, fake clock): first submit → request resume null, session event creates record with title; second submit after completion → resume id; submit while running → queued position 1, runs after first completes with same session; 11th queued → queue_full; idle: advance clock past timeout → `checkIdle` clears session + notice; no expiry while running; activity events push expiry; `submit` after timeout with no tick → new session (resume null) and expiry notice sent; newSession/setProject/resume refused while busy; setProject same cwd → unchanged, different → clears session; resume sets cwd + session; stop idle → idle; stop running → cancelPending called, queue dropped count, interrupt called, `⏹ Đã dừng.`; stop grace elapsed → abort + warning notice; runner throws → `❌ Lỗi:` and state not running; recoverAfterRestart with runningSince set → notice + cleared; status fields.

- [ ] failing tests → implement → PASS → check → commit `feat: session manager`.

### Task 10: History + resume resolution

**Files:** Create `src/sessions/history.ts`; Test `tests/sessions/history.test.ts`

**Produces:**
```ts
export const HISTORY_PAGE_SIZE = 10;
export const RECENTLY_MODIFIED_MS = 5 * 60 * 1000;
export interface SessionSource { list(options: { dir: string; limit: number; offset: number }): Promise<SDKSessionInfo[]>; info(sessionId: string): Promise<SDKSessionInfo | undefined> }
export interface HistoryEntry { sessionId: string; title: string; cwd: string | null; lastActiveAt: number; botOwned: boolean; maybeOpenElsewhere: boolean }
export interface HistoryPage { entries: HistoryEntry[]; page: number; hasMore: boolean }
export function listHistory(mode: 'bot' | 'all', chatId: number, page: number, deps: { store: StateStore; source: SessionSource; now: () => number }): Promise<HistoryPage>;
export type ResumeTarget = { kind: 'ok'; sessionId: string; cwd: string; title: string } | { kind: 'ambiguous'; sessionIds: string[] } | { kind: 'not_found' } | { kind: 'cwd_missing'; cwd: string } | { kind: 'too_short' };
export function resolveResumeTarget(arg: string, chatId: number, deps: { store: StateStore; source: SessionSource; pathExists: (p: string) => Promise<boolean> }): Promise<ResumeTarget>;
export const sdkSessionSource: SessionSource;   // listSessions / getSessionInfo
```
`all` mode: `source.list({ dir: chat.cwd, limit: 11, offset: page*10 })`, title `customTitle ?? summary`, botOwned = registry has id, maybeOpenElsewhere = `now - lastModified < 5 min && id !== chat.activeSessionId`. Resolution: arg length < 8 → too_short; candidates = registry ids for chat ∪ `list({dir: chat.cwd, limit: 200, offset: 0})` ids; exact match or unique prefix → `info(id)` must exist (else not_found); cwd = registry cwd ?? info.cwd ?? chat cwd; `pathExists(cwd)` false → cwd_missing.

Tests with fake source: bot pagination (25 records → pages 0..2, hasMore flags); all mode marks botOwned and ⚠️ window boundaries; prefix unique / ambiguous / none / too short; full id found only via info; info undefined → not_found; cwd missing.

- [ ] failing tests → implement → PASS → check → commit `feat: session history and resume resolution`.

### Task 11: Telegram bot layer

**Files:** Create `src/bot/auth.ts`, `src/bot/format.ts`, `src/bot/telegramIo.ts`, `src/bot/media.ts`, `src/bot/commands/{start,new,history,resume,project,stop,status,model}.ts`, `src/bot/handlers/{message,media,callbacks}.ts`, `src/bot/bot.ts`; Tests `tests/bot/auth.test.ts`, `tests/bot/format.test.ts`, `tests/bot/telegramIo.test.ts`

**Produces:**
```ts
// auth.ts
export function isAuthorized(update: { fromId: number | undefined; chatType: string | undefined }, allowed: ReadonlySet<number>): boolean;
export function createAuthMiddleware(allowed: ReadonlySet<number>, logger: Logger): MiddlewareFn<Context>;
// format.ts
export function relativeTime(thenMs: number, nowMs: number): string;        // 'vừa xong', 'N phút trước', 'N giờ trước', 'N ngày trước'
export function historyLine(entry: HistoryEntry, nowMs: number): string;
export function statusText(s: StatusSnapshot, nowMs: number): string;
export function formatDuration(ms: number): string;                        // '1 giờ 5 phút', '42 giây'
// telegramIo.ts
export class TelegramIo implements Notifier, PromptUi, FileSender {
  constructor(api: TelegramApiLike, logger: Logger);
}
export type TelegramApiLike = Pick<Api, 'sendMessage' | 'editMessageText' | 'sendChatAction' | 'sendDocument' | 'sendPhoto'>;
// media.ts
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export function downloadTelegramFile(api: Pick<Api, 'getFile'>, token: string, fileId: string, destDir: string, fileName: string): Promise<string>;  // returns absolute path
// bot.ts
export function createBot(deps: { config: AppConfig; manager: SessionManager; broker: PromptBroker; store: StateStore; io: TelegramIo; source: SessionSource; logger: Logger }): Bot;
export const BOT_COMMANDS: readonly { command: string; description: string }[];
```
TelegramIo: `sendMarkdown` → `markdownToTelegramChunks`; >4 chunks → first chunk + `sendDocument(InputFile(Buffer), 'response-<ts>.md', caption 'Phản hồi dài — xem file')`; each HTML send with `parse_mode: 'HTML'`; `GrammyError` whose description contains `can't parse entities` → log warn with html, resend as plain text (tags stripped, entities decoded); other errors → log error, never throw to caller for notices. `setTyping(true)` starts a 4 s interval calling `sendChatAction('typing')` immediately and repeatedly; `false` clears. PromptUi methods map to sendMessage/editMessageText with `reply_markup` built from `Button[][]` (`InlineKeyboard`), `editPrompt` with keyboard null → `reply_markup: { inline_keyboard: [] }`.

Handlers/commands behaviour: exactly spec section 8 table and 9.1. Order in `createBot`: `bot.use(auth)`; commands; `callback_query:data` → callbacks handler (prefixes `h:`, `r:`, `p:`, `m:`, `e:` handled here; `q:`/`a:` → broker; unknown → alert); `message:photo`, `message:document` → media handler; `message:text` → if `broker.consumeText` true → done; else manager.submit (reply `📥 Đã xếp hàng (vị trí N)` / `⚠️ Hàng đợi đầy (10). Dùng /stop hoặc đợi.`). `bot.catch` logs errors. Project snapshots: `Map<string, string[]>` keyed by random 6-char id, max 20 kept.

Tests: `isAuthorized` table (allowed private, allowed group, stranger private, undefined from); middleware does not call next for stranger; `relativeTime` boundaries; `historyLine` includes 🤖 / ⚠️ markers and project basename; `statusText` idle vs running vs waiting; TelegramIo with fake api: long markdown → file mode; parse error → plain resend; typing interval (fake timers) start/stop; editPrompt null keyboard shape.

- [ ] failing tests → implement → PASS → check → commit `feat: telegram bot layer`.

### Task 12: Bootstrap + shutdown

**Files:** Create `src/index.ts`

Sequence: `process.loadEnvFile(join(projectDir,'.env'))` when the file exists → `parseConfig` (ConfigError → print issues, exit 1) → `createLogger` → `acquireLock(dataDir/bot.lock)` (LockHeldError → log fatal, exit 1) → `parseGuardRules(read guard-rules.json)` → `StateStore.open` (quarantined → notify all allowed users after bot init) → TelegramIo, PromptBroker, SdkRunner (onGuardBlock → `io.sendNotice(chatId, '🛡 Đã chặn lệnh: <cmd> — <reason>')`), SessionManager → `createBot` → `bot.api.setMyCommands(BOT_COMMANDS)` → `manager.recoverAfterRestart()` → `manager.startIdleTimer()` → `process.on('warning')` logging `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` once at info (other warnings at warn) → `bot.start({ drop_pending_updates: false, allowed_updates: ['message','callback_query'] })`. SIGINT/SIGTERM → `bot.stop()` → `manager.shutdown()` → `lock.release()` → exit 0. `unhandledRejection`/`uncaughtException` → log fatal, exit 1.

- [ ] Implement → `npm run check` → `npm run build` succeeds → `node dist/index.js` with no `.env` prints ConfigError listing required vars and exits 1 (observed output recorded) → commit `feat: bootstrap and graceful shutdown`.

### Task 13: Windows scripts

**Files:** Create `scripts/run.ps1`, `scripts/install-task.ps1`, `scripts/uninstall-task.ps1`

- `run.ps1`: `Set-Location` project root; loop: start `node dist/index.js`, wait; exit code 0 → break; else append timestamped line to `logs/supervisor.log`, sleep backoff (5 s doubling to 300 s; reset to 5 s if the run lasted ≥ 600 s).
- `install-task.ps1`: runs `npm run build`; `Register-ScheduledTask -TaskName claude-pager -Force` with `New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"`, `New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited`, action `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<root>\scripts\run.ps1"` with `-WorkingDirectory <root>`, `New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew`; fails fast if `dist/index.js` or `.env` missing.
- `uninstall-task.ps1`: `Unregister-ScheduledTask -TaskName claude-pager -Confirm:$false` if exists; also stops running instance via `Stop-ScheduledTask`.

Verification: PowerShell parser check `[System.Management.Automation.Language.Parser]::ParseFile(...)` reports zero errors for each script. Registering the task is left to the user (changes system scheduled tasks).

- [ ] Implement → parse check → commit `feat: windows supervisor and scheduled task scripts`.

### Task 14: Docs

**Files:** Create `README.md` (Vietnamese: BotFather token, get user id via @userinfobot, `.env`, `npm install`, `npm run build`, `scripts/install-task.ps1`, commands, security: whitelist, Telegram 2FA, guard is not a boundary, sleep settings, Windows Update active hours, logs location), `.env.example`, `CLAUDE.md` (project commands + architecture map + rules), `lessons.md`.

- [ ] Write → commit `docs: readme, env example, project CLAUDE.md`.

### Task 15: Verification

- [ ] `npm run check` full output green; `npm run build` green.
- [ ] Smoke checklist (spec 14) requires a real bot token in `.env` created by the user; run with user's go-ahead and report each item pass/fail with evidence.
