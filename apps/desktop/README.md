# agentpager app

Electron app for Windows and macOS: it sits in the system tray / menu bar, has a window with **Status · Users · Settings · Log** and a first-run setup wizard. The app bundles the agentpager core and runs the bot with the Node that ships with Electron — no need to install Node/npm.

- The bot runs in a separate process (`agentpager --daemon`), so closing the window or "Quit app" does **not** stop the bot.
- Shares the app-data folder with agentpager cli (`%APPDATA%\agentpager`, `~/Library/Application Support/agentpager`): the app and the cli see the same config and the same running bot.
- "Start the bot at login" registers the app itself (`<app> --daemon`) with Task Scheduler / LaunchAgent. If autostart was turned on from the cli before, the Status screen offers to switch it to the app.
- App errors (not the bot's) are written to `logs/desktop.log`.

## Download and install

Download from [GitHub Releases](https://github.com/nguyenkechien/agentpager/releases). The installers are **not code-signed** (a personal project, no certificates bought), so the operating system warns the first time.

### Windows

1. Download `agentpager-Setup-<version>.exe` and run it.
2. SmartScreen shows "Windows protected your PC" → click **More info** → **Run anyway**.
3. The installer asks nothing: it installs the app for the current user into `%LOCALAPPDATA%\Programs\agentpager` (no admin rights needed), creates Start Menu and Desktop shortcuts, then opens the app.

### macOS

1. Download the `.dmg` for your chip: `agentpager-<version>-arm64.dmg` (Apple Silicon: M1 or later) or `agentpager-<version>-x64.dmg` (Intel). Check the chip under  → About This Mac.
2. Open the `.dmg` and drag **agentpager** into **Applications**. If you open the app straight from the `.dmg` or Downloads, it offers to move itself to Applications; starting the bot at login can only be turned on when the app is in Applications.
3. On first launch macOS says "Apple could not verify agentpager…": go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**, then open the app again. Or run in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/agentpager.app
   ```

Used agentpager cli before? The app reads the existing config right away (no wizard). If the bot is running from the cli, the Status screen has a **Run the bot from this app** button; if autostart points at the cli, it has a **Switch autostart to this app** button.

## Updates

- **Windows**: the app checks for new versions (at launch and every 6 hours), downloads them in the background, then shows "New version" with an **Update** button (also in the tray menu). The bot only stops when you click it. If the agent is running a turn or has queued messages, the app asks: **Update when idle** (installs once the agent is done), **Update now** (stops the running turn, the session is kept) or **Cancel**. After installing, the app reopens and starts the bot again; autostart stays as it was.
- **macOS**: the app announces new versions; the **Download** button opens the download page. Download the new `.dmg` and drag it over the old app in Applications (quit the app first; the bot keeps running the old version until you click Restart).
- Settings → **Version** shows the version in use, the check status and a **Check for updates** button.

## Uninstall

- **Windows**: Settings → Apps → Installed apps → agentpager → Uninstall. The uninstaller stops the bot if it runs from this app, and turns off autostart and the tray icon at login if they point at the app.
- **macOS**: Settings → **Uninstall agentpager from this computer?** does the same cleanup, then opens Finder so you can drag agentpager to the Trash.

The bot's config, state and logs (`%APPDATA%\agentpager`, `~/Library/Application Support/agentpager`) are **not deleted**: agentpager cli keeps working, and a reinstalled app picks them up again. To remove them for good, delete that folder by hand.

## Development

Run from the repo root:

```bash
npm install
npm run build -w packages/core     # the app uses the core build
npm run dev -w apps/desktop        # electron-vite, renderer hot reload
npm run check -w apps/desktop      # typecheck + lint + vitest (main + renderer)
npm run pack -w apps/desktop       # build + electron-builder --dir → apps/desktop/release/
npx playwright test                # (in apps/desktop) smoke on the packed build
npm run dist -w apps/desktop       # installer for the current machine: .exe (Windows) or .dmg (macOS)
npm run icons -w apps/desktop      # redraw icon.ico, icon-mac.png and the tray icons from build/icons/*.svg
```

- Smoke tests and every trial run should point `AGENTPAGER_HOME` at a temporary folder so they do not touch the real bot; each `AGENTPAGER_HOME` has its own IPC pipe, and the app keeps its window profile (including the single-instance lock) in `<AGENTPAGER_HOME>/desktop-profile`, so a trial build does not interfere with the real app that is open. While `AGENTPAGER_HOME` is set, the app does not turn autostart or the tray icon at login on or off, does not check for updates and does not offer to move to Applications: those are machine-wide settings.
- `npx playwright test -c playwright.installer.config.ts` runs the installer smoke (a real install into the user profile, then uninstall, on Windows; mounting the `.dmg` on macOS). The Windows one only runs on CI (`CI=true`).
- After editing the SVGs in `build/icons`, run `npm run icons` and commit the generated files; CI fails if they are out of sync.

Layout: `src/main` (main process: daemon, services, IPC, tray, window, `update/`, `maintenance/` for the installer), `src/preload` (the `window.agentpager` bridge), `src/renderer` (React), `src/shared` (shared data types and channel names). Design: `docs/superpowers/specs/2026-09-14-agentpager-desktop-design.md`, `docs/superpowers/specs/2026-09-15-agentpager-release-design.md`.

## Releasing

1. Bump `version` in `apps/desktop/package.json` and add a `## <version> — <date>` entry to `apps/desktop/CHANGELOG.md`. If the app needs a new core, publish `@chiennguyen/agentpager` first.
2. Commit, then create and push a tag matching the version:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

3. The `release` workflow checks the tag/version/changelog, builds the Windows installer and the arm64 and x64 `.dmg` files, runs the installer smoke, then uploads them to a **draft** GitHub Release and checks that every file is there.
4. Review the draft on GitHub, then click **Publish release**. Only then do installed apps see the update.

Trial run without releasing: Actions → release → **Run workflow** (the installers are in the run's artifacts).
