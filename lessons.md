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
- Splitting an oversized paragraph at any whitespace cut lines mid-way; prefer newline boundaries, then spaces.
- `npm` allow-scripts blocked esbuild's postinstall, but tsx and vitest still work because the platform binary ships as an optional dependency.
