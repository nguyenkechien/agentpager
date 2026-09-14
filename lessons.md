# Lessons

## 2026-09-14 — initial build

- typescript-eslint 8.70 has a peer range `typescript <6.1.0`; the latest TypeScript (7.x) cannot be used with it. Pinned TypeScript 6.0.3.
- Agent SDK 0.3.270: `Query.interrupt()` is a control request that only works with streaming input. Always pass an `AsyncIterable<SDKUserMessage>` prompt, even for plain text, or `/stop` silently does nothing.
- `AskUserQuestion`, critical-path `rm`/`rmdir`, and `ask` rules still reach `canUseTool` in `bypassPermissions` mode; without a handler the turn blocks. The callback options type requires `toolUseID` and `requestId`.
- SDK 0.3.270 `Query.streamInput` keeps stdin open until the first result only when the query has "bidirectional needs" (canUseTool, hooks, SDK MCP servers). The runner does not rely on that internal: its input generator stays open until a result arrives, so permission responses and interrupts always have a channel.
- PreToolUse hook denies apply even in `bypassPermissions` (documented in "Configure permissions").
- Guard regexes: Windows switches like `/q` and `/s` look like MSYS drive roots (`/c`). Keep POSIX (`rm`) and Windows (`Remove-Item`/`rd`/`del`) target lists separate.
- In `SessionManager`, dequeuing the next turn must not wait for the disk flush; tests using microtask ticks exposed the hidden I/O dependency.
- `npm` allow-scripts blocked esbuild's postinstall, but tsx and vitest still work because the platform binary ships as an optional dependency.
