# agentpager core (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Executed inline by the session that wrote the spec. Each task pins file paths, interfaces and test cases; code is written test-first inside the task (red → green → `npm run check` → commit). Snippets below fix the contracts other tasks rely on.

**Goal:** Build `agentpager`: provider-agnostic core with a `claude-code` provider, app-data config with username pairing, a background daemon controlled over IPC, a cross-platform CLI with autostart, npm packaging and CI.

**Architecture:** `src/core` (bot, sessions, prompts, guard, config, worker) depends only on `src/providers/types.ts`; `src/providers/claude-code` wraps the Agent SDK; `src/daemon` runs a supervisor that forks the worker and serves IPC; `src/platform` resolves paths/executables/autostart; `src/cli` is the `agentpager` command.

**Tech Stack:** Node ≥ 24, TypeScript 6.0.3, ESM, grammy 1.46.0, @anthropic-ai/claude-agent-sdk 0.3.270, zod 4, pino 10 + pino-roll 4, marked 18, vitest 5, eslint 10. No new runtime dependencies.

Spec: `docs/superpowers/specs/2026-09-14-agentpager-core-design.md` (§ numbers below).

## Global Constraints

- Package name `agentpager`, bin `agentpager`, app-data folder `agentpager`, LaunchAgent label `io.github.nguyenkechien.agentpager`, Windows task name `agentpager`, license MIT.
- Node `>=24`; all dependency versions exact; TypeScript must stay `< 6.1`.
- Telegram and CLI strings Vietnamese; code comments English.
- `src/core/**` must not import `@anthropic-ai/claude-agent-sdk` or `src/providers/claude-code/**` (enforced by a test).
- No `TODO`/`FIXME`, no `any`, no `@ts-ignore`, no `eslint-disable`, no empty catch, no weakened assertions.
- Quality gate per task: `npm run check` green, then commit. Push to `origin main` after every task once the repository exists.
- Outward-facing actions (create repo, push, npm publish) only with the user's go-ahead — repo creation + push were approved on 2026-09-14 (public); npm publish is NOT yet approved.
- The existing bot behaviour (commands, prompts, limits, rendering, guard, recovery) must keep passing its tests after files move.

## File Map (end state)

```
src/providers/types.ts                     Task 2
src/providers/registry.ts                  Task 3
src/providers/claude-code/{index,runner,events,canUseTool,guardHook,sendFileTool,history,usage,detect,models,labels}.ts   Task 3
src/core/prompts/broker.ts                 Task 3 (moved from src/claude/prompts.ts, generic API)
src/core/guard/policy.ts                   Task 3 (moved from src/claude/guard.ts matching part)
src/core/systemPrompt.ts                   Task 4
src/core/sessions/{store,manager,history,limits}.ts        Task 4 (moved)
src/core/bot/**                            Task 4 (moved from src/bot/**)
src/platform/paths.ts, src/platform/which.ts               Task 5
src/core/config/{schema,store}.ts                          Task 6
src/core/bot/auth.ts (pairing), src/core/config/allowedUsers.ts   Task 7
src/core/worker.ts, guard-rules.default.json               Task 8
src/daemon/{ipc,daemonInfo}.ts                             Task 9
src/daemon/{supervisor,main,workerEntry}.ts                Task 10
src/platform/autostart/{types,windows,macos,index}.ts      Task 11
src/cli/{main,args,io}.ts, src/cli/commands/*.ts           Task 12
package.json, README.md, LICENSE, .github/workflows/ci.yml Task 1 / Task 13
removed: src/index.ts, src/config.ts (Task 8), obsolete files (Task 13)
tests/** mirror src/**
```

---

### Task 1: Public repository baseline

**Files:** Modify `docs/superpowers/specs/2026-09-14-agentpager-core-design.md` (example identity), `package.json` (`name`, `description`, `license`, `repository`, `author`), `README.md` (title line), `CLAUDE.md` (name); Create `LICENSE` (MIT, `Copyright (c) 2026 nguyenkechien`).

- [ ] Replace the real Telegram username/id in the spec example with `example_user` / `123456789`; amend the unpushed HEAD commit that introduced them (verified it is the only commit containing them).
- [ ] Set `package.json` `"name": "agentpager"`, `"license": "MIT"`, `"repository": { "type": "git", "url": "git+https://github.com/nguyenkechien/agentpager.git" }`, `"author": "nguyenkechien"`; keep `"private": true` until Task 13.
- [ ] `npm run check` green; commit `chore: name package agentpager and add MIT license`.
- [ ] `gh repo create nguyenkechien/agentpager --public --source . --remote origin --description "Remote-control local coding agents (Claude Code, …) from Telegram"`; `git push -u origin main`; verify with `gh repo view nguyenkechien/agentpager --json visibility,defaultBranchRef`.

### Task 2: Provider types and boundary test

**Files:** Create `src/providers/types.ts`, `tests/providers/boundary.test.ts`, `tests/support/fakeProvider.ts`.

**Produces (exact):**
```ts
import type { Logger } from 'pino';

export type TurnInput =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; imageBase64: string; mediaType: 'image/jpeg'; imagePath: string; text: string };

export interface TurnRequest { chatId: number; cwd: string; resumeSessionId: string | null; model: string | null; effort: string | null; input: TurnInput }

export interface LimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  windowKey: string | null; windowLabel: string; scope: 'global' | 'model';
  resetsAtMs: number | null; utilizationPercent: number | null; threshold: number | null;
}

export type TurnEvent =
  | { type: 'session'; sessionId: string } | { type: 'activity' } | { type: 'tool'; name: string } | { type: 'result' }
  | { type: 'rate_limit'; snapshot: LimitSnapshot }
  | { type: 'api_retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'limit_error' };

export type TurnOutcome =
  | { kind: 'success'; text: string; costUsd: number | null }
  | { kind: 'error'; subtype: string; errors: string[]; costUsd: number | null };

export interface RunningTurn { interrupt(): Promise<void>; abort(): void; readonly done: Promise<TurnOutcome> }
export interface TurnSink { emit(event: TurnEvent): void }

export interface QuestionOption { label: string; description: string }
export interface Question { question: string; header: string; multiSelect: boolean; options: QuestionOption[] }
export type AskUserResult = { answers: Record<string, string> } | { declined: string };
export interface ApprovalRequest { title: string; reason: string | null; summary: string }
export type ApprovalResult = { allow: true } | { allow: false; message: string };
export interface InteractionBroker {
  askUser(chatId: number, questions: Question[], signal: AbortSignal): Promise<AskUserResult>;
  requestApproval(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
}

export interface GuardRule { id: string; pattern: RegExp; reason: string }
export interface GuardPolicy { match(command: string): GuardRule | null; onBlock(chatId: number, command: string, rule: GuardRule): void }

export interface FileSender {
  sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
  sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
}

export interface SessionInfo { sessionId: string; title: string; cwd: string | null; lastModified: number }
export interface SessionSource {
  list(options: { dir: string; limit: number; offset: number }): Promise<SessionInfo[]>;
  info(sessionId: string): Promise<SessionInfo | undefined>;
}

export interface UsageWindow { key: string; label: string; utilizationPercent: number | null; resetsAtMs: number | null }
export interface UsageReport { subscription: string | null; available: boolean; extraUsageEnabled: boolean; windows: UsageWindow[] }

export interface ProviderCapabilities {
  interrupt: 'native' | 'kill'; approvals: boolean; askUser: boolean; sessionListing: boolean;
  commandGuard: boolean; fileSendTool: boolean; imageInput: 'native' | 'path'; usage: 'plan-limits' | 'tokens' | 'none';
}
export interface ModelOption { id: string; label: string }
export interface Detection { executable: string | null; version: string | null; problems: string[] }
export interface ProviderSettings { executable: string | null }
export interface ProviderContext {
  guard: GuardPolicy; fileSender: FileSender; prompts: InteractionBroker; systemPrompt: string; logger: Logger;
}
export interface ProviderCatalogEntry {
  id: string; displayName: string; capabilities: ProviderCapabilities;
  models: readonly ModelOption[]; efforts: readonly string[];
  detect(settings: ProviderSettings): Promise<Detection>;
}
export interface AgentProvider extends ProviderCatalogEntry {
  startTurn(request: TurnRequest, sink: TurnSink): RunningTurn;
  sessions?: SessionSource;
  fetchUsage?(): Promise<UsageReport>;
}
export type ProviderFactory = (settings: ProviderSettings, context: ProviderContext) => AgentProvider;
```

Tests:
- `boundary.test.ts`: collects `src/providers/types.ts` plus every `.ts` under `src/core` (the folder is created in Task 3/4; until then only `types.ts` is scanned) and fails on any import of `@anthropic-ai/claude-agent-sdk` or a path containing `providers/claude-code`.
- `fakeProvider.ts`: `createFakeProvider(overrides?: Partial<ProviderCapabilities>)` returning `{ provider: AgentProvider; turns: FakeTurn[] }` (same FakeTurn semantics as today's manager tests) — used by later tasks.

- [ ] failing boundary test → types + fake → green → check → commit `feat: provider interface types` → push.

### Task 3: claude-code provider and generic prompt broker

**Files:** Create `src/providers/claude-code/*.ts`, `src/providers/registry.ts`, `src/core/prompts/broker.ts`, `src/core/guard/policy.ts`; move tests `tests/claude/*` → `tests/providers/claude-code/*` and `tests/claude/prompts.test.ts` → `tests/core/prompts/broker.test.ts`; delete `src/claude/*`, `src/sessions/history.ts` SDK source part, `src/claude/usage.ts`.

**Produces:**
```ts
// src/core/prompts/broker.ts — same UI/texts/timeouts as the existing bot behaviour
export class PromptBroker implements InteractionBroker {
  constructor(ui: PromptUi, options: { timeoutMs: number; logger: Logger; newId?: () => string });
  askUser(chatId: number, questions: Question[], signal: AbortSignal): Promise<AskUserResult>;
  requestApproval(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
  handleCallback(chatId: number, data: string): Promise<CallbackOutcome>;
  consumeText(chatId: number, text: string): Promise<boolean>;
  hasPending(chatId: number): boolean;
  cancelPending(chatId: number): void;
}
// declined texts reuse today's messages: timeout, 'The turn was cancelled', 'User stopped the turn'; approval deny message 'User denied this action via Telegram'.

// src/core/guard/policy.ts
export function matchGuard(command: string, rules: readonly GuardRule[]): GuardRule | null;
export function createGuardPolicy(rules: readonly GuardRule[], onBlock: GuardPolicy['onBlock']): GuardPolicy;
export function parseGuardRules(json: string): GuardRule[];   // moved from src/config.ts, throws GuardRulesError { issues: string[] }

// src/providers/claude-code/canUseTool.ts
export function createCanUseTool(chatId: number, prompts: InteractionBroker): CanUseTool;
// AskUserQuestion (zod-validated as today) → askUser → allow { ...input, answers } | deny declined; invalid input → deny 'Invalid AskUserQuestion input'
// other tools → requestApproval({ title: options.title ?? toolName, reason: options.decisionReason ?? null, summary }) → allow { updatedInput: input } | deny message

// src/providers/claude-code/guardHook.ts
export function createGuardHook(chatId: number, guard: GuardPolicy): HookCallbackMatcher;   // matcher 'Bash|PowerShell', deny reason 'Blocked by agentpager guard (<id>): <reason>'

// src/providers/claude-code/labels.ts
export function windowLabel(key: string | null): string;        // five_hour '5 giờ', seven_day & seven_day_overage_included '7 ngày', seven_day_opus '7 ngày · Opus', seven_day_sonnet '7 ngày · Sonnet', overage 'usage credits', else 'hiện tại'
export function windowScope(key: string | null): 'global' | 'model';   // model for seven_day_opus / seven_day_sonnet

// src/providers/claude-code/events.ts — today's eventsFromMessage/outcomeFromMessage/buildUserMessage, rate_limit snapshot now LimitSnapshot via labels.ts
// src/providers/claude-code/index.ts
export const claudeCodeCatalog: ProviderCatalogEntry;   // id 'claude-code', displayName 'Claude Code', capabilities all true / native / plan-limits, models opus|sonnet|haiku, efforts low|medium|high|xhigh|max, detect from detect.ts
export const createClaudeCodeProvider: ProviderFactory;
// src/providers/claude-code/detect.ts
export function detectClaudeCode(settings: ProviderSettings, deps: DetectDeps): Promise<Detection>;
export interface DetectDeps { platform: NodeJS.Platform; homedir: string; pathEnv: string; exists(path: string): Promise<boolean>; runVersion(executable: string): Promise<string | null> }
// src/providers/registry.ts
export const providerCatalog: readonly ProviderCatalogEntry[];
export function findCatalogEntry(id: string): ProviderCatalogEntry | undefined;
export function createProvider(id: string, settings: ProviderSettings, context: ProviderContext): AgentProvider;   // throws UnknownProviderError { knownIds }
```
`runner.ts` keeps SdkRunner behaviour (stream kept open until result, bypassPermissions, settingSources user/project/local, systemPrompt preset append = context.systemPrompt, canUseTool, mcpServers telegram send_file when fileSendTool, hooks PreToolUse guard). When `settings.executable` is null the `pathToClaudeCodeExecutable` option is omitted (SDK bundled binary).

Tests: existing claude suites moved and adapted (events incl. LimitSnapshot label/scope, tools, guard rules table, usage parsing); new `canUseTool.test.ts` (mapping both kinds, invalid input, abort passes signal), broker tests rewritten against `askUser`/`requestApproval` (all previous cases), `labels.test.ts`, `detect.test.ts` (order: configured path must exist → which on PATH skipping `.cmd/.ps1/.bat` → common paths per OS → null with the Vietnamese problem text; version timeout → null version), `registry.test.ts` (unknown id error lists ids).

- [ ] failing tests → implementation → move/adapt suites → check → commit `feat: claude-code provider behind the provider interface` → push.

### Task 4: Move bot and sessions into core; capability-driven behaviour

**Files:** Move `src/bot/**` → `src/core/bot/**`, `src/sessions/**` → `src/core/sessions/**` (tests likewise); Create `src/core/systemPrompt.ts`; Modify manager, limits, history, views, commands, handlers.

**Produces:**
```ts
// src/core/systemPrompt.ts
export function buildSystemPrompt(capabilities: ProviderCapabilities): string;   // base text from today's SYSTEM_PROMPT_APPEND; send_file line only if fileSendTool; AskUserQuestion line only if askUser; guard line only if commandGuard

// SessionManager deps: replace `runner: Runner` with `provider: Pick<AgentProvider, 'startTurn' | 'capabilities'>`
// stop(): capabilities.interrupt === 'kill' → abort() immediately, no grace timer; completion notice '⏹ Đã dừng.'
// LimitTracker: consumes LimitSnapshot (label/scope from snapshot); limitLabel table removed from core; UsageWindow/UsageReport imported from providers/types
// history.ts: SessionSource from providers/types; listHistory('all') only when a source exists; resolveResumeTarget with source === undefined → registry-only resolution (no info validation)
// BotDeps: replace `source`, `usage` with `provider: AgentProvider`
// views: modelView(models, efforts, model, effort) builds rows from provider lists (models row + efforts in rows of 3 + 'mặc định'); historyView hides the "📂 Mọi session của project" toggle when !sessionListing
// /history all without sessionListing → '📂 Provider này không hỗ trợ liệt kê mọi session.'
// /usage without fetchUsage → '📊 Provider này không cung cấp thông tin usage.'
// /status: add line '🛡 Guard: provider không hỗ trợ' when !commandGuard; add '🧠 Agent: <displayName>'
// media photo with imageInput 'path' → submit { kind: 'text', text: `${caption}\n\nẢnh đã lưu tại ${path}` }
// chat state model/effort: string | null; values not in provider lists are passed as null to startTurn and shown as default
```

Tests: all moved suites green; new `capabilities.test.ts` using `createFakeProvider` covering each row of spec §5 table; `systemPrompt.test.ts`; boundary test now scans `src/core`.

- [ ] failing capability tests → implementation → check → commit `refactor: provider-agnostic core with capability degradation` → push.

### Task 5: Platform paths and executable lookup

**Files:** Create `src/platform/paths.ts`, `src/platform/which.ts`; Tests `tests/platform/paths.test.ts`, `tests/platform/which.test.ts`.

**Produces:**
```ts
export interface PlatformInfo { platform: NodeJS.Platform; env: Record<string, string | undefined>; homedir: string; username: string }
export function currentPlatform(): PlatformInfo;
export interface AppPaths { root: string; config: string; state: string; daemonInfo: string; lock: string; guardRules: string; uploads: string; logs: string; ipc: string }
export function appPaths(info: PlatformInfo): AppPaths;
// root: AGENTPAGER_HOME → win32 `${APPDATA ?? homedir\AppData\Roaming}\agentpager` → darwin `${homedir}/Library/Application Support/agentpager` → other `${XDG_CONFIG_HOME ?? homedir/.config}/agentpager`
// ipc: win32 `\\.\pipe\agentpager-${username with [^A-Za-z0-9_-] replaced by _}` ; else `${root}/agentpager.sock`
export function findOnPath(name: string, deps: { platform: NodeJS.Platform; pathEnv: string; pathExt: string; exists(path: string): Promise<boolean> }): Promise<string | null>;
// win32: tries PATHEXT entries but never returns .cmd/.bat/.ps1 (SDK spawns directly); uses path.win32 / path.posix per platform
```
Tests: each platform branch (win32 with/without APPDATA, darwin, linux XDG), AGENTPAGER_HOME override, pipe name sanitising, findOnPath order and shim skipping, empty PATH.

- [ ] failing tests → implementation → check → commit `feat: platform paths and executable lookup` → push.

### Task 6: Config schema and store

**Files:** Create `src/core/config/schema.ts`, `src/core/config/store.ts`; Tests under `tests/core/config/`.

**Produces:**
```ts
export interface AllowedUser { username: string; userId: number | null; pairedAt: string | null }
export interface AgentpagerConfig {
  version: 1; telegram: { botToken: string }; allowedUsers: AllowedUser[]; projectsRoot: string;
  idleTimeoutMinutes: number; logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  agent: { provider: string; executable: string | null; defaultModel: string | null; defaultEffort: string | null };
}
export class ConfigError extends Error { readonly issues: string[] }
export function normalizeUsername(input: string): string;          // strips leading @, lowercases, requires /^[a-z0-9_]{5,32}$/ else ConfigError
export function validateConfig(raw: unknown, catalog: readonly ProviderCatalogEntry[]): AgentpagerConfig;   // throws ConfigError listing every issue: token format /^\d+:[A-Za-z0-9_-]{20,}$/, ≥1 allowed user, usernames valid, unique usernames/ids, projectsRoot absolute, idle integer ≥1, provider known, model/effort in provider lists, executable absolute when set
export function maskToken(token: string): string;                   // first 6 chars + '…' + last 3
export class ConfigStore {
  constructor(filePath: string, deps: { platform: NodeJS.Platform; catalog: readonly ProviderCatalogEntry[] });
  exists(): Promise<boolean>;
  read(): Promise<AgentpagerConfig>;                                // ENOENT → ConfigError(['Chưa có cấu hình — chạy "agentpager setup".'])
  write(config: AgentpagerConfig): Promise<void>;                   // validate, mkdir, tmp + rename, chmod 0o600 when platform !== 'win32'
  update(mutate: (current: AgentpagerConfig) => AgentpagerConfig): Promise<AgentpagerConfig>;   // re-read then write, serialized per store instance
}
```
Tests: valid config; each issue; model not in provider; masking; normalizeUsername cases; store round-trip, tmp cleanup, 0600 on darwin (skipped assertion of mode on win32 via platform flag, mode checked with fs.stat only when running on POSIX), concurrent `update` calls serialize (both mutations present).

- [ ] failing tests → implementation → check → commit `feat: app-data config store` → push.

### Task 7: Username pairing

**Files:** Create `src/core/config/allowedUsers.ts`; Modify `src/core/bot/auth.ts`; Tests `tests/core/bot/auth.test.ts`, `tests/core/config/allowedUsers.test.ts`.

**Produces:**
```ts
export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'pair'; username: string }
  | { kind: 'deny'; reason: 'not_private' | 'unknown_user' | 'username_paired_to_other_id' };
export function decideAuth(update: { fromId: number | undefined; username: string | undefined; chatType: string | undefined }, users: readonly AllowedUser[]): AuthDecision;
export class AllowedUsersRegistry {
  constructor(store: ConfigStore, now: () => Date);
  load(): Promise<void>; current(): readonly AllowedUser[];
  pair(username: string, userId: number): Promise<void>;           // store.update: set userId + pairedAt where username matches and userId null
  reload(): Promise<void>;
}
export function createAuthMiddleware(registry: AllowedUsersRegistry, logger: Logger): MiddlewareFn;
// pair → await registry.pair → ctx.reply('✅ Đã ghép @<username> với agentpager.') → next()
```
Tests: decision table (paired id allowed regardless of username; unpaired username → pair; username case-insensitive; username paired to other id → deny; unknown; group chat; missing from); middleware pairs once and persists (second update is `allow`), reply text, deny logs with reason; registry reload picks up external edits.

- [ ] failing tests → implementation → check → commit `feat: pair Telegram usernames to user ids` → push.

### Task 8: Worker bootstrap from app-data

**Files:** Create `src/core/worker.ts`, `guard-rules.default.json` (today's rules + macOS rules §11); Delete `src/index.ts`, `src/config.ts`, `guard-rules.json`; Tests `tests/core/worker.test.ts`, extend guard rule tests with macOS commands.

**Produces:**
```ts
export interface WorkerHandle { botUsername: string; provider: string; shutdown(): Promise<void>; reloadUsers(): Promise<void> }
export interface WorkerDeps { paths: AppPaths; platform: PlatformInfo; packageRoot: string; createBot?: typeof createBot; logger?: Logger }
export function startWorker(deps: WorkerDeps): Promise<WorkerHandle>;
// order: ConfigStore.read (ConfigError propagates) → logger(level, paths.logs, file base 'agentpager') → acquireLock(paths.lock)
// → guard rules: paths.guardRules if exists else packageRoot/guard-rules.default.json → StateStore(paths.state) → TelegramIo → PromptBroker
// → provider = createProvider(config.agent.provider, { executable }, { guard, fileSender: io, prompts: broker, systemPrompt: buildSystemPrompt(caps), logger })
// → LimitTracker(usage: provider.fetchUsage) → SessionManager(provider) → AllowedUsersRegistry → createBot → setMyCommands → recover/restore/idle timer → bot.start (not awaited; resolves after onStart)
// uploads dir = paths.uploads; projectsRoot/idle from config; getMe username for handle
```
macOS guard rules (added to the rule table tests, blocked): `diskutil eraseDisk JHFS+ X disk2`, `sudo shutdown -h now`, `shutdown -r now`, `sudo reboot`, `osascript -e 'tell app "System Events" to shut down'`, `rm -rf /Users/alex`, `rm -rf /System`, `rm -rf /Applications`, `killall node`; allowed: `diskutil list`, `rm -rf ./build`, `osascript -e 'display notification "x"'`.

Tests: worker with a fake `createBot` and fake provider catalog: missing config → ConfigError; lock held → LockHeldError; custom guard rules file preferred; shutdown releases lock and stops bot.

- [ ] failing tests → implementation → check → commit `feat: worker bootstrap from app-data config` → push.

### Task 9: IPC and daemon info

**Files:** Create `src/daemon/ipc.ts`, `src/daemon/daemonInfo.ts`; Tests `tests/daemon/ipc.test.ts`.

**Produces:**
```ts
export type IpcCommand = 'ping' | 'status' | 'stop' | 'restart' | 'reload-users';
export interface DaemonInfo { pid: number; startedAt: string; ipcPath: string; token: string }
export function readDaemonInfo(path: string): Promise<DaemonInfo | null>;      // missing/invalid → null
export function writeDaemonInfo(path: string, info: DaemonInfo, platform: NodeJS.Platform): Promise<void>;   // 0600 on POSIX
export function removeDaemonInfo(path: string): Promise<void>;
export function newToken(): string;                                               // 32 random bytes hex
export function startIpcServer(options: { path: string; token: string; platform: NodeJS.Platform; logger: Logger; handle(command: IpcCommand): Promise<unknown> }): Promise<{ close(): Promise<void> }>;
// POSIX: unlink stale socket before listen; newline-delimited JSON; wrong token → { ok:false, error:'unauthorized' } + warn log; unknown cmd → error
export class IpcError extends Error { readonly code: 'not_running' | 'timeout' | 'unauthorized' | 'failed' }
export function ipcRequest(info: DaemonInfo | null, command: IpcCommand, timeoutMs?: number): Promise<unknown>;   // default 5000; null info or ECONNREFUSED/ENOENT → not_running
```
Tests (real server on a temp socket/pipe name unique per test): round-trip each command, unauthorized token, not running (no info, stale path), timeout (handler never resolves, short timeout), daemon info read/write/remove + invalid JSON.

- [ ] failing tests → implementation → check → commit `feat: daemon IPC over named pipe / unix socket` → push.

### Task 10: Supervisor and daemon entry

**Files:** Create `src/daemon/supervisor.ts`, `src/daemon/main.ts`, `src/daemon/workerEntry.ts`; Tests `tests/daemon/supervisor.test.ts`.

**Produces:**
```ts
export type WorkerToSupervisor = { type: 'ready'; botUsername: string; provider: string } | { type: 'fatal'; message: string };
export type SupervisorToWorker = { type: 'shutdown' } | { type: 'reload-users' };
export interface WorkerProcess { readonly pid: number | undefined; send(message: SupervisorToWorker): void; onMessage(listener: (message: WorkerToSupervisor) => void): void; onExit(listener: (code: number | null) => void): void; kill(): void }
export interface SupervisorStatus { pid: number; startedAt: string; workerPid: number | null; workerState: 'starting' | 'running' | 'restarting' | 'stopped'; restarts: number; botUsername: string | null; provider: string | null; lastError: string | null }
export class Supervisor {
  constructor(deps: { spawnWorker(): WorkerProcess; now(): number; logger: Logger; pid: number; stopTimeoutMs?: number /* 20000 */; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout });
  start(): void; status(): SupervisorStatus; stop(): Promise<void>; restart(): Promise<void>; reloadUsers(): void;
  onFinished(listener: (reason: 'stopped' | 'fatal') => void): void;
}
// backoff 5_000 doubling to 300_000, reset when the previous worker ran ≥ 600_000; fatal message → no restart, finished('fatal'); exit code 0 after stop → finished('stopped')
export function runDaemon(options: { paths: AppPaths; platform: PlatformInfo; packageRoot: string; foreground: boolean }): Promise<number>;   // exit code
// writes daemon.json + IPC server; spawnWorker = child_process.fork(workerEntry, [], { execArgv: ['--disable-warning=CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'], stdio: foreground ? 'inherit' : 'ignore', windowsHide: true, env: { ...process.env, AGENTPAGER_HOME: paths.root } });
// SIGINT/SIGTERM → stop; on finish removes daemon.json and closes IPC; supervisor log line per start/exit/restart to paths.logs/supervisor.log
// workerEntry.ts: startWorker → process.send ready | fatal (ConfigError issues joined) → on 'shutdown' graceful then exit(0); on 'reload-users' registry reload
```
Tests with fake timers + fake WorkerProcess: ready → running; crash → restarting with 5 s, 10 s, … capped 300 s; long healthy run resets; fatal → finished fatal, no respawn; stop sends shutdown and waits for exit; stop timeout kills; restart spawns new worker after exit; reloadUsers forwards.

- [ ] failing tests → implementation → check → commit `feat: supervisor daemon with worker restart` → push.

### Task 11: Autostart for Windows and macOS

**Files:** Create `src/platform/autostart/{types,windows,macos,index}.ts`; Tests `tests/platform/autostart.test.ts`.

**Produces:**
```ts
export interface AutostartTarget { nodePath: string; cliPath: string; workingDir: string }
export interface AutostartStatus { enabled: boolean; target: AutostartTarget | null; problems: string[] }
export interface Autostart { enable(target: AutostartTarget): Promise<string[]>; disable(): Promise<string[]>; status(): Promise<AutostartStatus> }
export interface CommandRunner { run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> }

export function psQuote(value: string): string;                                   // single-quoted PowerShell literal, ' → ''
export function buildWindowsEnableScript(target: AutostartTarget): string;   // current user from [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; registers 'agentpager' with conhost.exe --headless "<node>" "<cli>" daemon, AtLogOn(user), Interactive/Limited, no time limit, StartWhenAvailable, battery flags, IgnoreNew
export function buildWindowsDisableScript(): string;
export function buildWindowsStatusScript(): string;                               // prints JSON { enabled, execute, arguments }
export function parseWindowsTaskArguments(argumentsText: string): AutostartTarget | null;
export function buildLaunchAgentPlist(target: AutostartTarget, logPath: string): string;   // XML-escaped, label io.github.nguyenkechien.agentpager, RunAtLoad true, KeepAlive false
export function createAutostart(deps: { platform: NodeJS.Platform; homedir: string; uid: number; paths: AppPaths; runner: CommandRunner; writeFile(path: string, text: string): Promise<void>; removeFile(path: string): Promise<void>; exists(path: string): Promise<boolean>; readFile(path: string): Promise<string | null> }): Autostart;   // unsupported platform → methods throw Error('Autostart chỉ hỗ trợ Windows và macOS')
// status adds problems when target node or cli path no longer exists
```
Tests: script text contains escaped paths with spaces and apostrophes, conhost headless action, parse arguments round-trip; plist XML exact snapshot with `&`/`<` escaping; macOS enable runs `launchctl bootout gui/<uid>/<label>` then `bootstrap gui/<uid> <plist>` via fake runner and ignores bootout "not loaded" (non-zero code) but fails on bootstrap error; disable removes plist; status problems for missing paths; Windows enable/disable/status through fake runner (powershell.exe -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64 script>).

- [ ] failing tests → implementation → check → commit `feat: autostart via Task Scheduler and LaunchAgent` → push.

### Task 12: CLI

**Files:** Create `src/cli/main.ts` (bin entry with `#!/usr/bin/env node`), `src/cli/args.ts`, `src/cli/io.ts`, `src/cli/commands/{setup,start,stop,restart,status,logs,autostart,config,users,help}.ts`; Tests `tests/cli/*.test.ts`.

**Produces:**
```ts
export interface ParsedArgs { command: string | null; positionals: string[]; flags: Record<string, string | true> }
export function parseArgs(argv: string[]): ParsedArgs;     // supports --flag, --flag=value, --flag value for known value flags (n), -f, -n <x>
export interface CliIo { out(line: string): void; err(line: string): void; ask(question: string, options?: { hidden?: boolean; defaultValue?: string }): Promise<string>; confirm(question: string, defaultYes: boolean): Promise<boolean> }
export function createTerminalIo(): CliIo;                 // node:readline/promises; hidden input mutes echo
export interface CliDeps {
  paths: AppPaths; platform: PlatformInfo; packageRoot: string; cliPath: string; version: string;
  configStore: ConfigStore; catalog: readonly ProviderCatalogEntry[]; autostart: Autostart;
  ipc(command: IpcCommand): Promise<unknown>;               // wraps readDaemonInfo + ipcRequest
  spawnDaemon(): void;                                      // detached spawn of `process.execPath cliPath daemon`, windowsHide, stdio ignore, unref
  runDaemonForeground(): Promise<number>;
  telegram: { getMe(token: string): Promise<{ username: string }> };
  sleep(ms: number): Promise<void>; now(): number;
  readLogTail(lines: number): Promise<string[]>; followLog(onLine: (line: string) => void): Promise<() => void>;
  exists(path: string): Promise<boolean>;
}
export function runCli(argv: string[], io: CliIo, deps: CliDeps): Promise<number>;
```
Command behaviour and texts: spec §9 table verbatim. `logs` formats pino JSON lines as `HH:mm:ss LEVEL msg {other keys}`; `daemon` (hidden command) calls `runDaemon`. `start` waits polling `status` every 500 ms up to 20 s.

Tests (fake deps/io): parseArgs cases; setup wizard happy path writes expected config (token verified, usernames normalised, projects root default per platform, detection shown, autostart/start offers), existing-config overwrite confirmation; start when running / spawn and ready / fatal / timeout message naming log path; stop not running; restart falls back to start; status output sections with masked token and pending users; logs formatting and tail count; autostart on/off/status messages; config show/set validation and restart hint; users add/remove/unpair with reload-users when running; unknown command → help + exit 1; `--version`.

- [ ] failing tests → implementation → check → commit `feat: agentpager CLI` → push.

### Task 13: Packaging, docs, CI

**Files:** Modify `package.json` (remove `private`, add `bin`, `files`, `engines`, `scripts.prepublishOnly`, `scripts.dev` → `tsx src/cli/main.ts start --foreground`, `scripts.start` → `node dist/cli/main.js start`), `tsconfig.build.json` (include json default rules copy step), `README.md` (install via npm, setup, commands, security, autostart, provider model), `CLAUDE.md` (architecture), `lessons.md`; Create `.github/workflows/ci.yml`; remove obsolete files.

`ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    strategy:
      matrix:
        os: [windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm run build
      - run: npm pack --dry-run
```
- [ ] `npm pack --dry-run` lists only `dist/**`, `guard-rules.default.json`, `README.md`, `LICENSE`, `package.json` (record output).
- [ ] check + build green → commit `chore: npm packaging, CI and docs` → push → `gh run watch` until the CI run finishes; both OS jobs green (report failures with logs and fix root causes).

### Task 14: Live verification (Windows)

- [ ] `npm run build`; the user runs `node dist/cli/main.js setup` (fresh config, bot token entered by the user); confirm config at `%APPDATA%\agentpager\config.json` with token masked in `config show`.
- [ ] `users list` shows the listed users as pending (not yet paired).
- [ ] Message the bot from each listed username to pair it.
- [ ] `node dist/cli/main.js autostart on` → `agentpager` task registered with conhost headless action (verify with `Get-ScheduledTask`); `start`, `status`, `logs -n 20`, `stop`, `restart`, `start --foreground` (Ctrl+C) — record outputs.
- [ ] Telegram via Telegram Web (user-approved channel): pairing message, `/status` shows Agent line, a Claude turn, `/usage`, `/model` lists provider models.
- [ ] `Start-ScheduledTask -TaskName agentpager` → process chain conhost → node daemon → node worker, no visible window.
- [ ] Update `lessons.md`; final commit + push.
