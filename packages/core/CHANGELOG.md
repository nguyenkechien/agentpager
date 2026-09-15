# Changelog

## 0.1.4 — 2026-09-15

- English everywhere: Telegram bot messages, buttons and command descriptions, CLI output and prompts, config validation, daemon and autostart messages. Counts use singular/plural forms and dates use `en-GB`.
- CLI confirmations accept `y`/`yes`/`n`/`no` (Vietnamese answers are no longer recognised).

## 0.1.3 — 2026-09-15

- The daemon reports whether the agent is busy or idle: the number of running turns and queued messages (`activeTurns`, `queuedInputs` in the IPC status). agentpager app uses them to avoid updating in the middle of a running turn.
- `agentpager status` shows a `Work: idle` or `Work: running N turns, M queued messages` line.

## 0.1.2 — 2026-09-14

- `agentpager autostart on|off` refuses while `AGENTPAGER_HOME` is set, and `setup` skips the autostart step: the Task Scheduler task / LaunchAgent is a machine-wide setting and does not carry that folder (previously it overwrote the main bot's autostart).
- Each `AGENTPAGER_HOME` has its own IPC named pipe on Windows; previously a daemon in another folder collided with the main bot's pipe and exited immediately.
- Errors while the daemon starts are written to `logs/supervisor.log` (synchronous writes, so the last line is not lost when the process exits).
- `agentpager autostart status` / `status`: warnings about paths that no longer exist share one form, "No longer exists: …", followed by a line explaining how to fix it.
- The autostart task quotes every argument; tasks created by 0.1.1 are still read.
- `daemon.json` records what launched the daemon (`launcher`: `cli` or `app`).
- The package adds entry points for the desktop app: `@chiennguyen/agentpager/{config,control,daemon,platform,providers}` (with type declarations).

## 0.1.1 — 2026-09-14

- Supports Node ≥ 22.

## 0.1.0 — 2026-09-14

- First release: a Telegram bot that controls Claude Code, a background daemon, the `agentpager` command, and autostart on Windows and macOS.
