# agentpager

Remote-control the coding agent on your machine (currently: Claude Code) through your own Telegram bot.

| Folder | Contents |
|---|---|
| [`packages/core`](packages/core) | The bot, the daemon and the `agentpager` command — npm package [`@chiennguyen/agentpager`](https://www.npmjs.com/package/@chiennguyen/agentpager). Installation and usage: [packages/core/README.md](packages/core/README.md). |
| [`apps/desktop`](apps/desktop) | agentpager app (Windows, macOS): set up, run, and view status, users, settings and logs without a terminal; updates itself on Windows. Download the installer from [Releases](https://github.com/nguyenkechien/agentpager/releases); guide in [apps/desktop/README.md](apps/desktop/README.md). |

## Development

```bash
npm install
npm run check   # build core, then typecheck + lint + test every workspace
npm run build
```

Design: `docs/superpowers/specs/`. MIT license.
