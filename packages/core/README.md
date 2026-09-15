# agentpager

Remote-control the coding agent on your machine (currently: **Claude Code**) through your own Telegram bot — for when something urgent comes up and you are away from the computer. Runs in the background on **Windows** and **macOS**, managed with the `agentpager` command.

- Keeps session context between messages; a session ends by itself after 60 minutes of inactivity (configurable).
- `/new`, `/history`, `/resume`, `/project`, `/stop`, `/status`, `/model`, `/usage`.
- Send photos/files to the agent; the agent sends files back through the `send_file` tool.
- The agent's multiple-choice questions and permission requests show up as buttons.
- The agent runs with **full permissions**, with a guard layer that blocks a few catastrophic commands.
- Whitelist by **@username**: the first private message from that username binds its user ID; from then on only the ID is trusted.

## ⚠️ Security — read first

- Whoever controls the bot can run any command on this machine. The bot only accepts messages in private chats from users on the list; anyone else gets no reply at all.
- **Turn on two-step verification for your Telegram account** (Settings → Privacy and Security → Two-Step Verification). Losing your Telegram account = losing control of the machine.
- Telegram usernames can change owners. After pairing, the bot trusts only the **user ID**; if a paired username messages from a different ID, the bot refuses and logs a warning.
- The guard is only a coarse safety net (regex), **not a security boundary** — it can be bypassed and can block by mistake.
- The bot token is stored in `config.json` in the user's app-data folder (mode `0600` on macOS). Do not share that file.

## Installation

Requires Node.js ≥ 22 and a signed-in Claude Code CLI (`claude` has been run once).

```bash
npm install -g @chiennguyen/agentpager
agentpager setup
```

> The npm package is named `@chiennguyen/agentpager` (npm rejected the name `agentpager` as too similar to another package); the command is still `agentpager`.
>
> Prefer not to use a terminal? [agentpager app](https://github.com/nguyenkechien/agentpager/tree/main/apps/desktop) (Windows, macOS) does the same job — download the installer from [Releases](https://github.com/nguyenkechien/agentpager/releases). The app and the cli share the same config and the same bot.
>
> Install from source: in the repo root run `npm install`, `npm run build -w packages/core`, then `npm link` in `packages/core` to get the `agentpager` command in every terminal (remove: `npm unlink -g @chiennguyen/agentpager`). The `agentpager` command uses the Node available in the terminal; with fnm/nvm, run `agentpager autostart on` again after changing the default Node version so the autostart task points at the right Node.
>
> PowerShell has no `head`: use `agentpager logs | Select-Object -First 20`.

`agentpager setup` asks, in order:

1. **Bot token** — create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`); the token is checked with Telegram.
2. **Usernames** allowed to use the bot (e.g. `@alice, @bob`).
3. **Folder that holds your projects** (default `D:\Projects` on Windows / `~/Projects` on macOS when it exists).
4. **Agent** and its CLI path (detected automatically; press Enter to accept).
5. Minutes of inactivity before a session ends.

After that you can turn on autostart and start right away. Send any message to the bot from each username to pair the account.

## The `agentpager` command

| Command | What it does |
|---|---|
| `setup` | First-time setup, or redo it |
| `start [--foreground]` | Run in the background (no window); `--foreground` runs in the current terminal, Ctrl+C to stop |
| `stop` / `restart` | Stop / restart (applies a new config) |
| `status` | Daemon, bot, agent, users, autostart, config and log paths |
| `logs [-f] [-n <lines>]` | Show the bot's log; `-f` keeps following it |
| `autostart on\|off\|status` | Start at login |
| `config path\|show\|set <key> <value>` | View/edit the config (the token is masked when shown) |
| `users list\|add <@u>\|remove <@u>\|unpair <@u>` | Manage users; a running bot picks up the change immediately |

`config set` keys: `telegram.botToken`, `projectsRoot`, `idleTimeoutMinutes`, `logLevel`, `agent.provider`, `agent.executable`, `agent.defaultModel`, `agent.defaultEffort` (`default` to clear).

## Autostart

- **Windows**: `agentpager autostart on` creates an `agentpager` task in Task Scheduler that runs when you sign in, through `conhost.exe --headless`, so no window appears. The bot only runs **after sign-in**: if Windows Update restarts the machine and nobody signs in, the bot stays offline — set **Active hours** and turn off Sleep while plugged in.
- **macOS**: creates the LaunchAgent `~/Library/LaunchAgents/io.github.nguyenkechien.agentpager.plist` (runs at login). Turn off sleep if the bot must stay online.
- The recorded command is the `node` and `agentpager` paths at the time autostart was turned on. After upgrading Node (e.g. through nvm), run `agentpager autostart on` again; `agentpager status` warns when a path no longer exists.

While `AGENTPAGER_HOME` is set, `agentpager autostart on|off` refuses and `setup` skips the autostart step: the task/LaunchAgent is a machine-wide setting and does not carry that folder.

The daemon restarts the bot when it crashes (5 seconds → up to 5 minutes) and stops for good when the config is invalid (see `agentpager status` / `logs`).

## Telegram commands

| Command | What it does |
|---|---|
| `/new` | The next message starts a new session (same project) |
| `/history` | Recent sessions started from the bot, tap one to resume; a button switches to every session of the project |
| `/resume` | Same as `/history`; or `/resume <id or its first ≥ 8 characters>` |
| `/project` | Pick a working folder inside the projects folder (switching projects ends the session) |
| `/stop` | Stop the running turn, cancel pending questions, drop the queue |
| `/status` | Agent, project, session, state, queue, time left, model |
| `/model` | Pick the agent's model and effort, applied from the next message |
| `/usage` | % used of the 5-hour / 7-day / per-model limits and reset times |

Messages sent while the agent is running are queued (up to 10). While the agent is asking a question, a text message is taken as the answer.

### Claude plan limits

- ⚠️ The server reports a limit is close → the bot sends a warning (once per threshold).
- ⛔ Limit reached → the bot reports the limit type and reset time, cancels the queue and keeps the session; new messages are blocked until the reset. Per-model limits do not block — use `/model` to switch models.
- ✅ Reset time reached → the bot messages you by itself (even after a restart).

## Data and logs

App-data folder: Windows `%APPDATA%\agentpager`, macOS `~/Library/Application Support/agentpager` (set `AGENTPAGER_HOME` to change it).

| File | Contents |
|---|---|
| `config.json` | Config (token, users, agent…) |
| `state.json` | Chat state and the session list |
| `daemon.json` | pid, IPC address and control token of the running daemon |
| `guard-rules.json` | Optional: replaces the default guard rules |
| `uploads/` | Files sent from Telegram |
| `logs/` | `agentpager.*.log` (rotated daily, 14 files kept), `supervisor.log` |

Claude sessions are still stored in `~/.claude/projects` as usual, so you can reopen them on the machine with `claude --resume <id>`.

## Agents (providers)

The core does not depend on a specific agent: each agent is a provider that declares its capabilities (stopping a turn, questions as buttons, permission requests, session listing, command guard, sending files, images, usage). Features a provider does not support are hidden or clearly reported in the bot. `claude-code` is available today; Codex, Cursor, Gemini… can be added later.

## Development

From the repo root (npm workspaces):

```bash
npm run check                    # build core, then typecheck + lint + test every workspace
npm run dev -w packages/core     # run the daemon in the terminal from source (tsx)
npm run build -w packages/core
```

Design: `docs/superpowers/specs/2026-09-14-agentpager-core-design.md`. MIT license.
