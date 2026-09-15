# Changelog — agentpager app

Versions of the desktop app (tags `vX.Y.Z` on GitHub Releases). agentpager cli has its own changelog in `packages/core/CHANGELOG.md`.

## 0.1.0 — 2026-09-15

- First installable release: a Windows installer (`agentpager-Setup-0.1.0.exe`, installs for the current user, no admin rights needed) and `.dmg` files for macOS on Apple Silicon and Intel.
- Windows downloads new versions by itself and shows an "Update" button; the bot only stops when you click it. If the agent is running a turn or has queued messages, the app asks first and can wait until the agent is idle before installing. After installing, the app reopens and starts the bot again.
- macOS announces new versions and opens the download page.
- New icon (a pager); the tray icon has a status-colored dot and suits light and dark taskbars/menu bars.
- Move a bot running from agentpager cli to the app with one button on the Status screen.
- Uninstall: turns off autostart and the tray icon at login when they point at the app, and keeps the bot's config and logs. On macOS, Settings has an uninstall button, and the app offers to move itself to Applications.
- Requires agentpager core 0.1.3 (bundled with the app).
