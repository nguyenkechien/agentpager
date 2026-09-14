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
- Live Telegram test (2026-09-14): the recovery notice promised "Session vẫn còn — nhắn tiếp để tiếp tục", but `lastActivityAt` from before the crash made the next message expire the session. Recovery now restarts the idle clock.
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
