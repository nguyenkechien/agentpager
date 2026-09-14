# agentpager desktop app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained Electron app (Windows + macOS) that sets up, starts, watches and configures the agentpager bot, next to the existing `@chiennguyen/agentpager` CLI in one monorepo.

**Architecture:** npm workspaces with `packages/core` (today's code, still the npm package) and `apps/desktop` (Electron 44, electron-vite, React). The app's main process calls the core through explicit package entry points; the bot runs as `<app executable> --daemon` using the core's `runDaemon`, and the renderer talks to the main process only through a typed, validated preload bridge.

**Tech Stack:** Node ≥ 22 (Electron's bundled Node 24.20.0 at runtime), TypeScript 6.0.3, ESM, Electron 44.3.0, electron-vite 5.0.0, Vite 7.3.6, @vitejs/plugin-react 5.2.0, React 19.3.0, electron-builder 26.15.3, vitest 5.0.0, jsdom 30.0.1, @testing-library/react 16.3.3, @testing-library/user-event 14.6.7, @testing-library/jest-dom 7.0.1, @playwright/test 1.63.0, zod 4, eslint 10 + typescript-eslint 8.70 (strictTypeChecked).

Spec: `docs/superpowers/specs/2026-09-14-agentpager-desktop-design.md` (section numbers below refer to it).

## Global Constraints

- All dependency versions are exact (no `^`/`~`); TypeScript must stay `< 6.1` (typescript-eslint peer range).
- `npm run check` must be green before every commit; push to `origin main` after each task.
- UI strings are Vietnamese; code comments are English; no personal identifiers (Telegram ids/usernames of the user) in code, tests or docs — use `example_user`, `test_bot`.
- `packages/core/src/core/**` and `packages/core/src/providers/types.ts` must never import the Agent SDK or `providers/claude-code` (existing boundary test).
- The desktop app imports the core only through `@chiennguyen/agentpager/{config,control,daemon,platform,providers}` — never deep paths.
- Renderer: `sandbox: true`, `contextIsolation: true`, no `nodeIntegration`, no remote content; the bot token never reaches the renderer except masked.
- IPC handlers never throw across the bridge: they return `{ ok: true, data }` or `{ ok: false, error: { code, message, fieldErrors? } }`.
- The daemon launched by the app is `<executable> --daemon` (packaged) or `<electron> <appPath> --daemon` (dev); autostart registers the same command with `console: false`.
- Windows-only: `console: true` autostart targets are wrapped in `conhost.exe --headless`; `console: false` targets are the task action itself. macOS ignores `console`.
- Out of scope: installers (.exe/.dmg), signing, notarization, auto-update, Linux, other providers, a chat UI, languages other than Vietnamese.
- The user's machine runs agentpager from the global npm install; never change that install, its scheduled task or its app-data files from a task step (the live check in Task 16 is the only exception and is done with the user).

## File Map

```
package.json                                   Task 1  workspace root (private), shared devDependencies, root scripts
tsconfig.base.json                             Task 1  compiler options shared by all packages
eslint.config.js                               Task 1, 5  ignores for dist/out/release; React hooks rules for the renderer
.github/workflows/ci.yml                       Task 1, 15  core matrix; desktop job
README.md                                      Task 1, 15  repository overview (npm README moves to packages/core)
CLAUDE.md, lessons.md                          Task 1, 15
packages/core/                                 Task 1  git mv of src/, tests/, guard-rules.default.json, vitest.config.ts, README.md; copy of LICENSE
packages/core/package.json                     Task 1, 4  moved manifest, workspace scripts, `exports`
packages/core/tsconfig.json, tsconfig.build.json  Task 1, 4
packages/core/src/control/daemon.ts            Task 2  start/stop/restart/status/users-changed returning results
packages/core/src/control/logFiles.ts          Task 2  moved from src/cli/logFiles.ts
packages/core/src/control/index.ts             Task 2  barrel
packages/core/src/cli/commands/daemonControl.ts  Task 2  terminal output over control results
packages/core/src/platform/autostart/*         Task 3  generic target { command, args, workingDir, console }
packages/core/src/daemon/daemonInfo.ts, main.ts  Task 4  `launcher`, `workerEnv`
packages/core/src/{core/config,daemon,platform,providers}/index.ts  Task 4  barrels behind `exports`
apps/desktop/package.json, electron.vite.config.ts, electron-builder.yml, playwright.config.ts, vitest.config.ts  Task 5
apps/desktop/tsconfig.json                     Task 5  main, preload, shared, tests/main, tests/smoke, config files
apps/desktop/src/renderer/tsconfig.json        Task 5  renderer (DOM, JSX)
apps/desktop/tests/renderer/tsconfig.json      Task 5  renderer tests (DOM, JSX)
apps/desktop/src/main/launchMode.ts            Task 5  argv → daemon | gui (hidden)
apps/desktop/src/main/daemonProcess.ts         Task 5  daemon command for spawn/autostart, runDaemon from the app
apps/desktop/src/main/index.ts                 Task 5, 9  entry: routes --daemon, boots the GUI
apps/desktop/src/shared/api.ts                 Task 6  bridge types shared by main, preload, renderer
apps/desktop/src/main/services/results.ts      Task 6  ApiResult helpers, ConfigError → fieldErrors
apps/desktop/src/main/services/configService.ts  Task 6  load/save/wizard/verifyToken/defaults/users
apps/desktop/src/main/services/daemonService.ts  Task 6  DaemonView, start/stop/restart
apps/desktop/src/main/services/autostartService.ts Task 6  get/set with ownership
apps/desktop/src/main/ipc/schemas.ts           Task 7  zod input schemas
apps/desktop/src/main/ipc/handlers.ts          Task 7  ipcMain.handle registration with sender check
apps/desktop/src/preload/index.ts              Task 7  window.agentpager
apps/desktop/src/main/live/statusPoller.ts     Task 8  2 s poll, push on change
apps/desktop/src/main/live/configWatcher.ts    Task 8  fs.watch + 300 ms debounce
apps/desktop/src/main/live/logStream.ts        Task 8  followLog + 250 ms batches
apps/desktop/src/main/shell/trayModel.ts       Task 9  pure tray state → icon colour + menu items
apps/desktop/src/main/shell/trayIcon.ts        Task 9  RGBA circle bitmaps for tray icons
apps/desktop/src/main/shell/appShell.ts        Task 9  window, tray, single instance, login item, crash handling
apps/desktop/src/main/shell/desktopLog.ts      Task 9  logs/desktop.log for main-process errors
apps/desktop/src/renderer/*                    Task 10–14  React UI
apps/desktop/tests/main/**                     Task 5–9
apps/desktop/tests/renderer/**                 Task 10–14
apps/desktop/tests/smoke/app.smoke.ts          Task 5, 15  packaged Playwright smoke
docs/superpowers/plans/2026-09-14-agentpager-desktop.md  this plan
```

---

### Task 1: npm workspaces monorepo with `packages/core`

**Files:**
- Move: `src/` → `packages/core/src/`, `tests/` → `packages/core/tests/`, `guard-rules.default.json`, `vitest.config.ts`, `README.md`, `package.json`, `tsconfig.json`, `tsconfig.build.json` → `packages/core/`
- Create: `package.json` (root), `tsconfig.base.json`, `README.md` (root), `packages/core/LICENSE` (copy)
- Modify: `packages/core/package.json`, `packages/core/tsconfig.json`, `eslint.config.js`, `.gitignore`, `.github/workflows/ci.yml`, `CLAUDE.md`
- Test: existing suites (473 tests) run from `packages/core`

**Interfaces:**
- Consumes: nothing.
- Produces: root `npm run check` (builds core, then `check` in every workspace), root `npm run build`; `packages/core` scripts `typecheck`, `lint`, `test`, `check`, `build`, `clean`, `prepublishOnly`; `tsconfig.base.json` for all packages.

- [ ] **Step 1: Move the package into `packages/core`**

```bash
mkdir -p packages/core
git mv src packages/core/src
git mv tests packages/core/tests
git mv guard-rules.default.json packages/core/guard-rules.default.json
git mv vitest.config.ts packages/core/vitest.config.ts
git mv README.md packages/core/README.md
git mv package.json packages/core/package.json
git mv tsconfig.json packages/core/tsconfig.json
git mv tsconfig.build.json packages/core/tsconfig.build.json
cp LICENSE packages/core/LICENSE
git add packages/core/LICENSE
```

- [ ] **Step 2: Create the shared compiler options `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 3: Point `packages/core/tsconfig.json` at the base**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`packages/core/tsconfig.build.json` stays as it is (it extends `./tsconfig.json`).

- [ ] **Step 4: Create the root `package.json`**

```json
{
  "name": "agentpager-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "check": "npm run build -w packages/core && npm run check --workspaces --if-present"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "24.13.4",
    "eslint": "10.10.0",
    "tsx": "4.23.13",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.0",
    "vitest": "5.0.0"
  }
}
```

- [ ] **Step 5: Rewrite `packages/core/package.json`** (devDependencies now live at the root; `repository.directory` added)

```json
{
  "name": "@chiennguyen/agentpager",
  "version": "0.1.1",
  "type": "module",
  "description": "Remote-control local coding agents (Claude Code, …) from a private Telegram bot.",
  "license": "MIT",
  "author": "nguyenkechien",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/nguyenkechien/agentpager.git",
    "directory": "packages/core"
  },
  "homepage": "https://github.com/nguyenkechien/agentpager#readme",
  "bugs": {
    "url": "https://github.com/nguyenkechien/agentpager/issues"
  },
  "keywords": ["telegram", "bot", "claude-code", "coding-agent", "remote-control", "cli"],
  "bin": {
    "agentpager": "dist/cli/main.js"
  },
  "files": ["dist", "guard-rules.default.json", "README.md", "LICENSE"],
  "engines": {
    "node": ">=22"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "dev": "tsx src/cli/main.ts start --foreground",
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/cli/main.js start",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "npm run typecheck && npm run lint && npm run test",
    "prepublishOnly": "npm run clean && npm run check && npm run build"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.270",
    "@anthropic-ai/sdk": "0.125.0",
    "@modelcontextprotocol/sdk": "1.30.0",
    "grammy": "1.46.0",
    "marked": "18.0.13",
    "pino": "10.3.1",
    "pino-roll": "4.0.0",
    "zod": "4.6.5"
  }
}
```

- [ ] **Step 6: Update `eslint.config.js` ignores** (the rest of the file is unchanged)

```js
  { ignores: ['**/dist/', '**/out/', '**/release/', '**/node_modules/', '**/test-results/'] },
```

- [ ] **Step 7: Replace `.gitignore`**

```
node_modules/
dist/
out/
release/
test-results/
playwright-report/
*.log
*.tgz
```

- [ ] **Step 8: Create the root `README.md`**

```markdown
# agentpager

Điều khiển agent lập trình trên máy (hiện tại: Claude Code) từ xa qua một bot Telegram riêng.

| Thư mục | Nội dung |
|---|---|
| [`packages/core`](packages/core) | Bot, daemon và lệnh `agentpager` — gói npm [`@chiennguyen/agentpager`](https://www.npmjs.com/package/@chiennguyen/agentpager). Hướng dẫn cài đặt và sử dụng: [packages/core/README.md](packages/core/README.md). |
| [`apps/desktop`](apps/desktop) | App desktop (Windows, macOS): cài đặt, chạy, xem trạng thái và log không cần terminal. |

## Phát triển

```bash
npm install
npm run check   # build core, rồi typecheck + lint + test mọi workspace
npm run build
```

Thiết kế: `docs/superpowers/specs/`. Giấy phép MIT.
```

- [ ] **Step 9: Install to convert the lockfile to the workspace layout**

Run: `npm install`
Expected: `package-lock.json` now has `"packages": { "": { "name": "agentpager-workspace", "workspaces": [...] }, "packages/core": {...} }` and `node_modules/@chiennguyen/agentpager` is a link to `packages/core`.

- [ ] **Step 10: Update `.github/workflows/ci.yml`**

```yaml
name: ci
on: [push, pull_request]
jobs:
  core:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    name: core (${{ matrix.os }}, node ${{ matrix.node }})
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build -w packages/core
      - run: npm run check -w packages/core
      - run: npm pack --dry-run -w packages/core
```

- [ ] **Step 11: Update `CLAUDE.md`** — replace the `## Commands` section and prefix every architecture path with `packages/core/`:

```markdown
## Commands

- `npm run check` (root) — build `packages/core`, then typecheck + eslint + vitest in every workspace (must be green before committing)
- `npm run build -w packages/core` / `npm run start -w packages/core` — compile the core to `packages/core/dist/` and run the CLI
- `npm run dev -w packages/core` — run the daemon in the foreground from `src/` with tsx
- `npm publish -w packages/core` — publish `@chiennguyen/agentpager` (the user runs it: npm 2FA)
```

In `## Architecture`, every bullet's first path gains the prefix, e.g. `` `packages/core/src/core/worker.ts` ``, `` `packages/core/src/daemon/` ``; the boundary sentence becomes `` `packages/core/src/core/**` and `packages/core/src/providers/types.ts` must never import … (enforced by `packages/core/tests/providers/boundary.test.ts`) ``.

- [ ] **Step 12: Verify the move**

Run: `npm run check`
Expected: core build succeeds; the same test files and test counts as before the move, all passing; eslint and tsc exit 0.

Run: `npm pack --dry-run -w packages/core`
Expected: the same file count as `npm pack --dry-run` before the move; contents `LICENSE`, `README.md`, `guard-rules.default.json`, `package.json`, `dist/**` only.

Run: `node packages/core/dist/cli/main.js --version`
Expected: `0.1.1`

- [ ] **Step 13: Commit and push**

```bash
git add -A
git commit -m "chore: move the core into an npm workspace (packages/core)"
git push origin main
```

---

### Task 2: Core `control/` module shared by the CLI and the app

**Files:**
- Create: `packages/core/src/control/daemon.ts`, `packages/core/src/control/index.ts`
- Move: `packages/core/src/cli/logFiles.ts` → `packages/core/src/control/logFiles.ts`; `packages/core/tests/cli/logFiles.test.ts` → `packages/core/tests/control/logFiles.test.ts`
- Modify: `packages/core/src/cli/commands/daemonControl.ts`, `packages/core/src/cli/deps.ts:13`, `packages/core/src/cli/commands/logs.ts:1`
- Test: `packages/core/tests/control/daemon.test.ts`; existing `packages/core/tests/cli/*.test.ts` stay green unchanged

**Interfaces:**
- Consumes: `IpcError`, `IpcCommand`, `IpcErrorCode` from `src/daemon/ipc.ts`; `SupervisorStatus` from `src/daemon/supervisor.ts`; `FATAL_WORKER_LOG` (already used by logFiles).
- Produces (`packages/core/src/control/daemon.ts`):
  - `START_TIMEOUT_MS = 20_000`, `STOP_TIMEOUT_MS = 25_000`, `POLL_INTERVAL_MS = 500`
  - `interface DaemonControlDeps { ipc(command: IpcCommand): Promise<unknown>; spawnDaemon(): void; lastDaemonFatal(sinceMs: number): Promise<string | null>; sleep(ms: number): Promise<void>; now(): number }` (function properties)
  - `type WorkerResult = { kind: 'running'; status: SupervisorStatus } | { kind: 'fatal'; message: string } | { kind: 'timeout' }`
  - `type StartResult = { kind: 'already_running'; status: SupervisorStatus } | WorkerResult`
  - `type StopResult = { kind: 'stopped' } | { kind: 'not_running' } | { kind: 'timeout' }`
  - `type UsersChangedResult = { kind: 'reloaded' } | { kind: 'not_running' } | { kind: 'failed'; code: IpcErrorCode; message: string }`
  - `readDaemonStatus(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<SupervisorStatus | null>` — null only for `not_running`, other IPC errors throw
  - `startDaemon(deps: DaemonControlDeps): Promise<StartResult>`
  - `restartDaemon(deps: DaemonControlDeps, previous: SupervisorStatus, onRequested?: () => void): Promise<WorkerResult>` — `onRequested` runs after the daemon accepted `restart`
  - `stopDaemon(deps: Pick<DaemonControlDeps, 'ipc' | 'sleep' | 'now'>): Promise<StopResult>`
  - `notifyUsersChanged(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<UsersChangedResult>`
- Produces (`packages/core/src/control/logFiles.ts`, unchanged API): `formatLogLine`, `newestLogFile`, `readLogTail`, `lastDaemonFatal`, `followLog`, `SUPERVISOR_LOG`, `DEFAULT_FOLLOW_INTERVAL_MS`.

- [ ] **Step 1: Move the log file helpers and their tests**

```bash
mkdir -p packages/core/src/control packages/core/tests/control
git mv packages/core/src/cli/logFiles.ts packages/core/src/control/logFiles.ts
git mv packages/core/tests/cli/logFiles.test.ts packages/core/tests/control/logFiles.test.ts
```

In `packages/core/tests/control/logFiles.test.ts` change the import line to:

```ts
import { followLog, formatLogLine, lastDaemonFatal, newestLogFile, readLogTail } from '../../src/control/logFiles.js';
```

In `packages/core/src/cli/deps.ts` change the logFiles import to:

```ts
import { followLog, lastDaemonFatal, readLogTail } from '../control/logFiles.js';
```

In `packages/core/src/cli/commands/logs.ts` change the first import to:

```ts
import { formatLogLine } from '../../control/logFiles.js';
```

- [ ] **Step 2: Write the failing tests `packages/core/tests/control/daemon.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  notifyUsersChanged,
  readDaemonStatus,
  restartDaemon,
  START_TIMEOUT_MS,
  startDaemon,
  stopDaemon,
  type DaemonControlDeps,
} from '../../src/control/daemon.js';
import { IpcError, type IpcCommand } from '../../src/daemon/ipc.js';
import type { SupervisorStatus } from '../../src/daemon/supervisor.js';

function status(overrides: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    pid: 42,
    startedAt: '2026-09-14T08:00:00.000Z',
    workerPid: 100,
    workerState: 'running',
    restarts: 0,
    botUsername: 'test_bot',
    provider: 'claude-code',
    lastError: null,
    ...overrides,
  };
}

const notRunning = (): IpcError => new IpcError('not_running', 'agentpager không chạy');

interface Harness {
  deps: DaemonControlDeps;
  calls: IpcCommand[];
  spawned: () => number;
  elapsed: () => number;
}

/** `respond` returns the IPC data or throws the IPC error for the n-th call (1-based). */
function harness(respond: (command: IpcCommand, call: number) => unknown, fatal: string | null = null): Harness {
  const calls: IpcCommand[] = [];
  let clock = 1_000;
  let spawned = 0;
  const deps: DaemonControlDeps = {
    ipc: (command) => {
      calls.push(command);
      try {
        return Promise.resolve(respond(command, calls.length));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    spawnDaemon: () => {
      spawned += 1;
    },
    lastDaemonFatal: () => Promise.resolve(fatal),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { deps, calls, spawned: () => spawned, elapsed: () => clock - 1_000 };
}

describe('readDaemonStatus', () => {
  it('parses the status, returns null when nothing runs and rethrows other IPC errors', async () => {
    await expect(readDaemonStatus(harness(() => status()).deps)).resolves.toEqual(status());
    await expect(
      readDaemonStatus(
        harness(() => {
          throw notRunning();
        }).deps,
      ),
    ).resolves.toBeNull();
    await expect(
      readDaemonStatus(
        harness(() => {
          throw new IpcError('timeout', 'Daemon không phản hồi sau 5000 ms');
        }).deps,
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('startDaemon', () => {
  it('reports a daemon that already runs without spawning', async () => {
    const h = harness(() => status());
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'already_running', status: status() });
    expect(h.spawned()).toBe(0);
  });

  it('spawns and waits until the worker is running', async () => {
    const h = harness((_command, call) => {
      if (call === 1) throw notRunning();
      return call < 4 ? status({ workerState: 'starting' }) : status();
    });
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'running', status: status() });
    expect(h.spawned()).toBe(1);
    expect(h.calls).toEqual(['status', 'status', 'status', 'status']);
  });

  it('returns the fatal worker error', async () => {
    const h = harness(() => {
      throw notRunning();
    }, 'Token Telegram không hợp lệ (401 Unauthorized)');
    await expect(startDaemon(h.deps)).resolves.toEqual({
      kind: 'fatal',
      message: 'Token Telegram không hợp lệ (401 Unauthorized)',
    });
  });

  it('times out after 20 seconds', async () => {
    const h = harness(() => {
      throw notRunning();
    });
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'timeout' });
    expect(h.elapsed()).toBeGreaterThanOrEqual(START_TIMEOUT_MS);
  });

  it('keeps waiting while the status request itself fails', async () => {
    const h = harness((_command, call) => {
      if (call === 1) throw notRunning();
      if (call === 2) throw new IpcError('failed', 'Daemon đóng kết nối mà không trả lời');
      return status();
    });
    await expect(startDaemon(h.deps)).resolves.toEqual({ kind: 'running', status: status() });
  });
});

describe('restartDaemon', () => {
  it('asks the daemon to restart and waits for a new worker', async () => {
    const previous = status({ workerPid: 100 });
    const h = harness((command, call) => {
      if (command === 'restart') return { restarting: true };
      return call < 3 ? status({ workerPid: 100, workerState: 'restarting' }) : status({ workerPid: 101, restarts: 1 });
    });
    await expect(restartDaemon(h.deps, previous)).resolves.toEqual({
      kind: 'running',
      status: status({ workerPid: 101, restarts: 1 }),
    });
    expect(h.calls[0]).toBe('restart');
  });
});

describe('stopDaemon', () => {
  it('reports when nothing runs', async () => {
    const h = harness(() => {
      throw notRunning();
    });
    await expect(stopDaemon(h.deps)).resolves.toEqual({ kind: 'not_running' });
  });

  it('waits until the daemon no longer answers', async () => {
    const h = harness((command, call) => {
      if (command === 'stop') return { stopping: true };
      if (call < 3) return status();
      throw notRunning();
    });
    await expect(stopDaemon(h.deps)).resolves.toEqual({ kind: 'stopped' });
  });

  it('times out when the daemon keeps answering', async () => {
    const h = harness(() => status());
    await expect(stopDaemon(h.deps)).resolves.toEqual({ kind: 'timeout' });
  });
});

describe('notifyUsersChanged', () => {
  it('distinguishes reloaded, not running and failed', async () => {
    await expect(notifyUsersChanged(harness(() => ({ reloaded: true })).deps)).resolves.toEqual({ kind: 'reloaded' });
    await expect(
      notifyUsersChanged(
        harness(() => {
          throw notRunning();
        }).deps,
      ),
    ).resolves.toEqual({ kind: 'not_running' });
    await expect(
      notifyUsersChanged(
        harness(() => {
          throw new IpcError('failed', 'Daemon báo lỗi: Worker chưa chạy');
        }).deps,
      ),
    ).resolves.toEqual({ kind: 'failed', code: 'failed', message: 'Daemon báo lỗi: Worker chưa chạy' });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/control/daemon.test.ts` (in `packages/core`)
Expected: FAIL — `Cannot find module '../../src/control/daemon.js'`.

- [ ] **Step 4: Implement `packages/core/src/control/daemon.ts`**

```ts
import { z } from 'zod';
import { IpcError, type IpcCommand, type IpcErrorCode } from '../daemon/ipc.js';
import type { SupervisorStatus } from '../daemon/supervisor.js';

export const START_TIMEOUT_MS = 20_000;
export const STOP_TIMEOUT_MS = 25_000;
export const POLL_INTERVAL_MS = 500;

export interface DaemonControlDeps {
  ipc: (command: IpcCommand) => Promise<unknown>;
  /** Starts a detached daemon process; the caller decides which executable runs it. */
  spawnDaemon: () => void;
  /** The latest fatal worker error the supervisor logged at or after `sinceMs`. */
  lastDaemonFatal: (sinceMs: number) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type WorkerResult =
  | { kind: 'running'; status: SupervisorStatus }
  | { kind: 'fatal'; message: string }
  | { kind: 'timeout' };

export type StartResult = { kind: 'already_running'; status: SupervisorStatus } | WorkerResult;

export type StopResult = { kind: 'stopped' } | { kind: 'not_running' } | { kind: 'timeout' };

export type UsersChangedResult =
  | { kind: 'reloaded' }
  | { kind: 'not_running' }
  | { kind: 'failed'; code: IpcErrorCode; message: string };

const statusSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  workerPid: z.number().nullable(),
  workerState: z.enum(['starting', 'running', 'restarting', 'stopped']),
  restarts: z.number(),
  botUsername: z.string().nullable(),
  provider: z.string().nullable(),
  lastError: z.string().nullable(),
});

/** Null when no daemon answers; other IPC failures propagate. */
export async function readDaemonStatus(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<SupervisorStatus | null> {
  try {
    return statusSchema.parse(await deps.ipc('status'));
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') return null;
    throw error;
  }
}

/** While a daemon starts or stops, a failed status request just means "ask again". */
async function pollStatus(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<SupervisorStatus | null | 'unavailable'> {
  try {
    return await readDaemonStatus(deps);
  } catch (error) {
    if (error instanceof IpcError) return 'unavailable';
    throw error;
  }
}

async function waitForWorker(
  deps: DaemonControlDeps,
  sinceMs: number,
  isExpectedWorker: (status: SupervisorStatus) => boolean,
): Promise<WorkerResult> {
  const deadline = deps.now() + START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const status = await pollStatus(deps);
    if (status !== null && status !== 'unavailable' && status.workerState === 'running' && isExpectedWorker(status)) {
      return { kind: 'running', status };
    }
    const fatal = await deps.lastDaemonFatal(sinceMs);
    if (fatal !== null) return { kind: 'fatal', message: fatal };
  }
  return { kind: 'timeout' };
}

export async function startDaemon(deps: DaemonControlDeps): Promise<StartResult> {
  const running = await readDaemonStatus(deps);
  if (running) return { kind: 'already_running', status: running };
  const since = deps.now();
  deps.spawnDaemon();
  return waitForWorker(deps, since, () => true);
}

export async function restartDaemon(
  deps: DaemonControlDeps,
  previous: SupervisorStatus,
  onRequested?: () => void,
): Promise<WorkerResult> {
  const since = deps.now();
  await deps.ipc('restart');
  onRequested?.();
  return waitForWorker(deps, since, (status) => status.workerPid !== previous.workerPid);
}

export async function stopDaemon(deps: Pick<DaemonControlDeps, 'ipc' | 'sleep' | 'now'>): Promise<StopResult> {
  try {
    await deps.ipc('stop');
  } catch (error) {
    if (error instanceof IpcError && error.code === 'not_running') return { kind: 'not_running' };
    throw error;
  }
  const deadline = deps.now() + STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if ((await pollStatus(deps)) === null) return { kind: 'stopped' };
  }
  return { kind: 'timeout' };
}

/** Tells a running bot to re-read allowed users; a stopped daemon needs nothing. */
export async function notifyUsersChanged(deps: Pick<DaemonControlDeps, 'ipc'>): Promise<UsersChangedResult> {
  try {
    await deps.ipc('reload-users');
    return { kind: 'reloaded' };
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    if (error.code === 'not_running') return { kind: 'not_running' };
    return { kind: 'failed', code: error.code, message: error.message };
  }
}
```

- [ ] **Step 5: Create the barrel `packages/core/src/control/index.ts`**

```ts
export * from './daemon.js';
export * from './logFiles.js';
```

- [ ] **Step 6: Rewrite `packages/core/src/cli/commands/daemonControl.ts` over the control results** (same terminal texts as before)

```ts
import {
  notifyUsersChanged as notifyDaemon,
  readDaemonStatus,
  restartDaemon as restartWorker,
  START_TIMEOUT_MS,
  startDaemon as startWorker,
  STOP_TIMEOUT_MS,
  stopDaemon as stopWorker,
  type DaemonControlDeps,
  type WorkerResult,
} from '../../control/daemon.js';
import { IpcError } from '../../daemon/ipc.js';
import type { SupervisorStatus } from '../../daemon/supervisor.js';
import type { CliIo } from '../io.js';
import type { CliDeps } from '../types.js';

export const RESTART_HINT = 'Chạy "agentpager restart" để áp dụng.';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Null when no daemon answers; other IPC failures propagate. */
export function daemonStatus(deps: CliDeps): Promise<SupervisorStatus | null> {
  return readDaemonStatus(deps);
}

function controlDeps(deps: CliDeps): DaemonControlDeps {
  return { ipc: deps.ipc, spawnDaemon: deps.spawnDaemon, lastDaemonFatal: deps.lastDaemonFatal, sleep: deps.sleep, now: deps.now };
}

function reportWorker(io: CliIo, deps: CliDeps, result: WorkerResult): number {
  switch (result.kind) {
    case 'running':
      io.out(`✅ agentpager đang chạy · bot @${result.status.botUsername ?? '?'} · pid ${result.status.pid}`);
      return 0;
    case 'fatal':
      io.err(`❌ ${result.message}`);
      return 1;
    case 'timeout':
      io.err(`❌ agentpager chưa sẵn sàng sau ${START_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
      return 1;
  }
}

export async function startDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  // Fail with the configuration problems here instead of inside a detached process.
  await deps.configStore.read();
  const result = await startWorker(controlDeps(deps));
  if (result.kind === 'already_running') {
    io.out(`agentpager đang chạy (pid ${result.status.pid})`);
    return 0;
  }
  return reportWorker(io, deps, result);
}

export async function restartDaemon(io: CliIo, deps: CliDeps, previous: SupervisorStatus): Promise<number> {
  const result = await restartWorker(controlDeps(deps), previous, () => {
    io.out('🔄 Đang khởi động lại…');
  });
  return reportWorker(io, deps, result);
}

export async function stopDaemon(io: CliIo, deps: CliDeps): Promise<number> {
  const result = await stopWorker(controlDeps(deps));
  switch (result.kind) {
    case 'not_running':
      io.out('agentpager không chạy');
      return 0;
    case 'stopped':
      io.out('⏹ Đã dừng agentpager.');
      return 0;
    case 'timeout':
      io.err(`❌ agentpager chưa dừng sau ${STOP_TIMEOUT_MS / 1000} giây — xem log trong ${deps.paths.logs}`);
      return 1;
  }
}

/** Tells a running bot to re-read allowed users; a stopped daemon needs nothing. */
export async function notifyUsersChanged(io: CliIo, deps: CliDeps): Promise<void> {
  const result = await notifyDaemon(deps);
  if (result.kind === 'reloaded') io.out('Đã cập nhật danh sách cho bot đang chạy.');
  if (result.kind === 'failed') io.err(`⚠️ Không báo được cho daemon (${result.message}) — chạy "agentpager restart".`);
}

export async function printRestartHintIfRunning(io: CliIo, deps: CliDeps): Promise<void> {
  try {
    if ((await readDaemonStatus(deps)) !== null) io.out(RESTART_HINT);
  } catch (error) {
    // A daemon that answers with an error is still running.
    if (!(error instanceof IpcError)) throw error;
    io.out(RESTART_HINT);
  }
}
```

Note the restart output order in the CLI test (`['🔄 Đang khởi động lại…', '✅ …']`) is preserved.

- [ ] **Step 7: Run the core checks**

Run: `npm run check -w packages/core`
Expected: all suites pass, including `tests/control/daemon.test.ts` (11 tests) and the unchanged `tests/cli/commands.test.ts`.

- [ ] **Step 8: Commit and push**

```bash
git add -A packages/core
git commit -m "refactor: share daemon control and log reading between CLI and app"
git push origin main
```

---

### Task 3: Generic autostart target `{ command, args, workingDir, console }`

**Files:**
- Modify: `packages/core/src/platform/autostart/types.ts`, `packages/core/src/platform/autostart/windows.ts`, `packages/core/src/platform/autostart/macos.ts`, `packages/core/src/platform/autostart/targetProblems.ts`, `packages/core/src/cli/commands/autostart.ts`, `packages/core/src/cli/commands/status.ts`
- Test: `packages/core/tests/platform/autostart.test.ts` (rewritten), `packages/core/tests/cli/support.ts`, `packages/core/tests/cli/commands.test.ts`, `packages/core/tests/cli/setup.test.ts`

**Interfaces:**
- Consumes: `psQuote`, `powershellArgs`, `buildWindowsDisableScript`, `buildWindowsStatusScript` (unchanged).
- Produces:
  - `interface AutostartTarget { command: string; args: string[]; workingDir: string; console: boolean }` — `console` is Windows-only and parsed as `false` on macOS
  - `windowsTaskAction(target: AutostartTarget): { execute: string; argument: string }`
  - `splitWindowsArguments(text: string): string[]`
  - `parseWindowsTaskAction(execute: string, argumentsText: string, workingDir: string): AutostartTarget | null`
  - `buildWindowsEnableScript(target: AutostartTarget): string` (now built from the action)
  - `buildLaunchAgentPlist(target, logPath)` writes `ProgramArguments = [command, ...args]`; `parseLaunchAgentPlist(text): AutostartTarget | null`
  - `targetProblems(target, exists): Promise<string[]>` — messages `Không còn tìm thấy <path>` for `command` and every absolute path in `args`
  - CLI `autostartTarget(deps): AutostartTarget` → `{ command: nodePath, args: [cliPath, 'daemon'], workingDir: homedir, console: true }`
  - Removed: `windowsTaskArguments`, `parseWindowsTaskArguments`

- [ ] **Step 1: Write the failing tests — replace `packages/core/tests/platform/autostart.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createAutostart } from '../../src/platform/autostart/index.js';
import { buildLaunchAgentPlist, launchAgentPath, parseLaunchAgentPlist } from '../../src/platform/autostart/macos.js';
import { targetProblems } from '../../src/platform/autostart/targetProblems.js';
import type { AutostartDeps, AutostartTarget, CommandResult } from '../../src/platform/autostart/types.js';
import {
  buildWindowsDisableScript,
  buildWindowsEnableScript,
  buildWindowsStatusScript,
  parseWindowsTaskAction,
  psQuote,
  splitWindowsArguments,
  windowsTaskAction,
} from '../../src/platform/autostart/windows.js';
import { appPaths } from '../../src/platform/paths.js';

const cliTarget: AutostartTarget = {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ["C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\@chiennguyen\\agentpager\\dist\\cli\\main.js", 'daemon'],
  workingDir: "C:\\Users\\O'Brien",
  console: true,
};

const appTarget: AutostartTarget = {
  command: 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe',
  args: ['--daemon'],
  workingDir: 'C:\\Users\\alex',
  console: false,
};

const macTarget: AutostartTarget = {
  command: '/Users/alex/.nvm/versions/node/v24.1.0/bin/node',
  args: ['/Users/alex/Tools & <Apps>/agentpager/dist/cli/main.js', 'daemon'],
  workingDir: '/Users/alex',
  console: true,
};

interface FakeEnv {
  deps: AutostartDeps;
  calls: { command: string; args: string[] }[];
  files: Map<string, string>;
  dirs: string[];
}

function fakeEnv(platform: NodeJS.Platform, results: CommandResult[], existing: string[] = []): FakeEnv {
  const calls: { command: string; args: string[] }[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const present = new Set(existing);
  const homedir = platform === 'win32' ? "C:\\Users\\O'Brien" : '/Users/alex';
  const deps: AutostartDeps = {
    platform,
    homedir,
    uid: 501,
    paths: appPaths({ platform, env: {}, homedir, username: 'alex' }),
    runner: {
      run: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(results.shift() ?? { code: 0, stdout: '', stderr: '' });
      },
    },
    writeFile: (path, text) => {
      files.set(path, text);
      present.add(path);
      return Promise.resolve();
    },
    removeFile: (path) => {
      files.delete(path);
      present.delete(path);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(present.has(path)),
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
    makeDir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
  };
  return { deps, calls, files, dirs };
}

function decodeScript(args: string[]): string {
  expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  return Buffer.from(args[5] ?? '', 'base64').toString('utf16le');
}

describe('Windows task action', () => {
  it('wraps console programs in conhost --headless and runs GUI programs directly', () => {
    expect(windowsTaskAction(cliTarget)).toEqual({
      execute: 'conhost.exe',
      argument:
        "--headless \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\@chiennguyen\\agentpager\\dist\\cli\\main.js\" \"daemon\"",
    });
    expect(windowsTaskAction(appTarget)).toEqual({
      execute: 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe',
      argument: '"--daemon"',
    });
  });

  it('splits quoted and bare arguments', () => {
    expect(splitWindowsArguments('--headless "C:\\a b\\node.exe" "C:\\cli.js" daemon')).toEqual([
      '--headless',
      'C:\\a b\\node.exe',
      'C:\\cli.js',
      'daemon',
    ]);
    expect(splitWindowsArguments('')).toEqual([]);
  });

  it('parses both action shapes back into targets', () => {
    const cli = windowsTaskAction(cliTarget);
    expect(parseWindowsTaskAction(cli.execute, cli.argument, cliTarget.workingDir)).toEqual(cliTarget);
    const app = windowsTaskAction(appTarget);
    expect(parseWindowsTaskAction(app.execute, app.argument, appTarget.workingDir)).toEqual(appTarget);
    // Tasks registered by agentpager 0.1.x left the last argument unquoted.
    expect(parseWindowsTaskAction('conhost.exe', '--headless "C:\\node.exe" "C:\\cli.js" daemon', 'C:\\')).toEqual({
      command: 'C:\\node.exe',
      args: ['C:\\cli.js', 'daemon'],
      workingDir: 'C:\\',
      console: true,
    });
    expect(parseWindowsTaskAction('conhost.exe', 'powershell.exe -File other.ps1', 'C:\\')).toBeNull();
    expect(parseWindowsTaskAction('', '', 'C:\\')).toBeNull();
  });
});

describe('Windows scripts', () => {
  it('quotes PowerShell literals, including typographic quotes', () => {
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'");
    expect(psQuote('D:\\Nguyễn’s')).toBe("'D:\\Nguyễn’’s'");
  });

  it('registers a headless logon task for a console target', () => {
    const script = buildWindowsEnableScript(cliTarget);
    expect(script).toContain('$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).toContain(
      `New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(windowsTaskAction(cliTarget).argument)} -WorkingDirectory 'C:\\Users\\O''Brien'`,
    );
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user');
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain(
      '-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    );
    expect(script).toContain("Register-ScheduledTask -TaskName 'agentpager'");
  });

  it('registers the app executable itself for a GUI target', () => {
    const script = buildWindowsEnableScript(appTarget);
    expect(script).toContain(
      "New-ScheduledTaskAction -Execute 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe' -Argument '\"--daemon\"' -WorkingDirectory 'C:\\Users\\alex'",
    );
    expect(script).not.toContain('conhost');
  });

  it('omits -Argument when a target has no arguments', () => {
    expect(buildWindowsEnableScript({ ...appTarget, args: [] })).toContain(
      "New-ScheduledTaskAction -Execute 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe' -WorkingDirectory 'C:\\Users\\alex'",
    );
  });

  it('builds disable and status scripts for the agentpager task', () => {
    expect(buildWindowsDisableScript()).toContain("Unregister-ScheduledTask -TaskName 'agentpager' -Confirm:$false");
    expect(buildWindowsStatusScript()).toContain("Get-ScheduledTask -TaskName 'agentpager'");
  });
});

describe('Windows autostart', () => {
  it('enables through PowerShell', async () => {
    const env = fakeEnv('win32', [{ code: 0, stdout: 'REGISTERED\r\n', stderr: '' }]);
    const messages = await createAutostart(env.deps).enable(appTarget);
    expect(env.calls[0]?.command).toBe('powershell.exe');
    expect(decodeScript(env.calls[0]?.args ?? [])).toBe(buildWindowsEnableScript(appTarget));
    expect(messages).toEqual(['Đã bật tự khởi động agentpager khi đăng nhập Windows (Task Scheduler).']);
  });

  it('fails with the PowerShell error output', async () => {
    const env = fakeEnv('win32', [{ code: 1, stdout: '', stderr: 'Access is denied.' }]);
    await expect(createAutostart(env.deps).enable(cliTarget)).rejects.toThrow('Access is denied.');
  });

  it('disables the task or explains it was not enabled', async () => {
    const env = fakeEnv('win32', [
      { code: 0, stdout: 'REMOVED\r\n', stderr: '' },
      { code: 0, stdout: 'NOT_REGISTERED\r\n', stderr: '' },
    ]);
    const autostart = createAutostart(env.deps);
    await expect(autostart.disable()).resolves.toEqual(['Đã tắt tự khởi động agentpager.']);
    await expect(autostart.disable()).resolves.toEqual(['Tự khởi động chưa được bật.']);
  });

  it('reads either target shape and warns about paths that no longer exist', async () => {
    const statusJson = (target: AutostartTarget): string => {
      const action = windowsTaskAction(target);
      return `${JSON.stringify({ enabled: true, execute: action.execute, arguments: action.argument, workingDirectory: target.workingDir })}\r\n`;
    };
    const env = fakeEnv(
      'win32',
      [
        { code: 0, stdout: statusJson(cliTarget), stderr: '' },
        { code: 0, stdout: statusJson(appTarget), stderr: '' },
        { code: 0, stdout: '{"enabled":false}\r\n', stderr: '' },
        { code: 0, stdout: `${JSON.stringify({ enabled: true, execute: 'conhost.exe', arguments: 'powershell.exe -File other.ps1' })}\r\n`, stderr: '' },
      ],
      [cliTarget.command],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: cliTarget,
      problems: [`Không còn tìm thấy ${cliTarget.args[0] ?? ''}`],
    });
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: appTarget,
      problems: [`Không còn tìm thấy ${appTarget.command}`],
    });
    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: null,
      problems: ['Task agentpager chạy lệnh không nhận ra: conhost.exe powershell.exe -File other.ps1'],
    });
  });
});

describe('targetProblems', () => {
  it('checks the command and absolute path arguments only', async () => {
    const exists = (path: string): Promise<boolean> => Promise.resolve(path === appTarget.command);
    await expect(targetProblems(appTarget, exists)).resolves.toEqual([]);
    await expect(targetProblems({ ...cliTarget }, exists)).resolves.toEqual([
      `Không còn tìm thấy ${cliTarget.command}`,
      `Không còn tìm thấy ${cliTarget.args[0] ?? ''}`,
    ]);
  });
});

describe('LaunchAgent plist', () => {
  it('escapes XML and runs the target at login without KeepAlive', () => {
    expect(buildLaunchAgentPlist(macTarget, '/Users/alex/Library/Application Support/agentpager/logs/launchd.log')).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>io.github.nguyenkechien.agentpager</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/Users/alex/.nvm/versions/node/v24.1.0/bin/node</string>',
        '    <string>/Users/alex/Tools &amp; &lt;Apps&gt;/agentpager/dist/cli/main.js</string>',
        '    <string>daemon</string>',
        '  </array>',
        '  <key>WorkingDirectory</key>',
        '  <string>/Users/alex</string>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <false/>',
        '  <key>StandardOutPath</key>',
        '  <string>/Users/alex/Library/Application Support/agentpager/logs/launchd.log</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>/Users/alex/Library/Application Support/agentpager/logs/launchd.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  it('parses the plist it writes (console is Windows-only)', () => {
    expect(parseLaunchAgentPlist(buildLaunchAgentPlist(macTarget, '/tmp/launchd.log'))).toEqual({ ...macTarget, console: false });
    const appOnMac: AutostartTarget = {
      command: '/Applications/agentpager.app/Contents/MacOS/agentpager',
      args: ['--daemon'],
      workingDir: '/Users/alex',
      console: false,
    };
    expect(parseLaunchAgentPlist(buildLaunchAgentPlist(appOnMac, '/tmp/launchd.log'))).toEqual(appOnMac);
    expect(parseLaunchAgentPlist('<plist><dict></dict></plist>')).toBeNull();
  });
});

describe('macOS autostart', () => {
  const plist = launchAgentPath('/Users/alex');
  const logs = '/Users/alex/Library/Application Support/agentpager/logs';

  it('writes the plist, reloads it with launchctl and ignores a missing previous load', async () => {
    const env = fakeEnv('darwin', [
      { code: 113, stdout: '', stderr: 'Could not find service' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(createAutostart(env.deps).enable(macTarget)).resolves.toEqual([
      'Đã bật tự khởi động agentpager khi đăng nhập macOS (LaunchAgent).',
    ]);
    expect(env.dirs).toEqual(['/Users/alex/Library/LaunchAgents', logs]);
    expect(env.files.get(plist)).toBe(buildLaunchAgentPlist(macTarget, `${logs}/launchd.log`));
    expect(env.calls).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/io.github.nguyenkechien.agentpager'] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', plist] },
    ]);
  });

  it('fails when launchctl cannot load the agent', async () => {
    const env = fakeEnv('darwin', [
      { code: 0, stdout: '', stderr: '' },
      { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' },
    ]);
    await expect(createAutostart(env.deps).enable(macTarget)).rejects.toThrow('Bootstrap failed: 5: Input/output error');
  });

  it('disables by unloading and deleting the plist', async () => {
    const env = fakeEnv('darwin', []);
    const autostart = createAutostart(env.deps);
    await expect(autostart.disable()).resolves.toEqual(['Tự khởi động chưa được bật.']);
    await autostart.enable(macTarget);
    await expect(autostart.disable()).resolves.toEqual(['Đã tắt tự khởi động agentpager.']);
    expect(env.files.has(plist)).toBe(false);
    expect(env.calls.at(-1)).toEqual({ command: 'launchctl', args: ['bootout', 'gui/501/io.github.nguyenkechien.agentpager'] });
  });

  it('reports loaded state, target and problems', async () => {
    const env = fakeEnv(
      'darwin',
      [
        { code: 113, stdout: '', stderr: 'Could not find service' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'state = running', stderr: '' },
        { code: 113, stdout: '', stderr: 'not found' },
      ],
      [macTarget.command],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });
    await autostart.enable(macTarget);
    const loaded = await autostart.status();
    expect(loaded).toMatchObject({ enabled: true, target: { ...macTarget, console: false } });
    expect(loaded.problems).toEqual([`Không còn tìm thấy ${macTarget.args[0] ?? ''}`]);
    const unloaded = await autostart.status();
    expect(unloaded.enabled).toBe(false);
    expect(unloaded.problems).toContain('LaunchAgent có file nhưng chưa được nạp.');
  });
});

describe('unsupported platforms', () => {
  it('rejects every operation', async () => {
    const autostart = createAutostart(fakeEnv('linux', []).deps);
    await expect(autostart.enable(macTarget)).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
    await expect(autostart.disable()).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
    await expect(autostart.status()).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/platform/autostart.test.ts` (in `packages/core`)
Expected: FAIL — `windowsTaskAction is not exported` / type errors on `command`.

- [ ] **Step 3: Change `AutostartTarget` in `packages/core/src/platform/autostart/types.ts`**

Replace the interface with:

```ts
/** The command autostart launches, captured when autostart is turned on. */
export interface AutostartTarget {
  command: string;
  args: string[];
  workingDir: string;
  /**
   * Windows only: a console program (node) is wrapped in `conhost.exe --headless` so no window appears.
   * macOS ignores it and reads it back as `false`.
   */
  console: boolean;
}
```

- [ ] **Step 4: Replace `packages/core/src/platform/autostart/targetProblems.ts`**

```ts
import { posix, win32 } from 'node:path';
import type { AutostartTarget } from './types.js';

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** Paths the registered command relies on that no longer exist (e.g. Node upgraded, app moved). */
export async function targetProblems(target: AutostartTarget, exists: (path: string) => Promise<boolean>): Promise<string[]> {
  const problems: string[] = [];
  for (const path of [target.command, ...target.args.filter(isAbsolutePath)]) {
    if (!(await exists(path))) problems.push(`Không còn tìm thấy ${path}`);
  }
  return problems;
}
```

- [ ] **Step 5: Replace the action and parsing parts of `packages/core/src/platform/autostart/windows.ts`**

Remove `windowsTaskArguments` and `parseWindowsTaskArguments` and add, below `psQuote`:

```ts
/** Task Scheduler arguments: every value in double quotes (Windows paths and our flags never contain `"`). */
function quoteArgument(value: string): string {
  return `"${value}"`;
}

/**
 * The scheduled task action for a target. Console programs (node) run inside `conhost.exe --headless`, because
 * the Windows 11 default terminal ignores hidden-window flags; GUI programs (the desktop app) are the action itself.
 */
export function windowsTaskAction(target: AutostartTarget): { execute: string; argument: string } {
  const args = target.args.map(quoteArgument);
  if (target.console) {
    return { execute: 'conhost.exe', argument: ['--headless', quoteArgument(target.command), ...args].join(' ') };
  }
  return { execute: target.command, argument: args.join(' ') };
}

export function splitWindowsArguments(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
}

export function parseWindowsTaskAction(execute: string, argumentsText: string, workingDir: string): AutostartTarget | null {
  const tokens = splitWindowsArguments(argumentsText);
  if (/(^|\\)conhost\.exe$/i.test(execute)) {
    const [flag, command, ...args] = tokens;
    if (flag !== '--headless' || !command) return null;
    return { command, args, workingDir, console: true };
  }
  if (execute.trim() === '') return null;
  return { command: execute, args: tokens, workingDir, console: false };
}
```

In `buildWindowsEnableScript`, replace the `$action = …` line with:

```ts
    `$action = New-ScheduledTaskAction -Execute ${psQuote(action.execute)}${argument} -WorkingDirectory ${psQuote(target.workingDir)}`,
```

with these two lines at the top of the function body (before `return [`):

```ts
  const action = windowsTaskAction(target);
  const argument = action.argument === '' ? '' : ` -Argument ${psQuote(action.argument)}`;
```

and remove the old comment line about conhost (the comment now lives on `windowsTaskAction`).

In `createWindowsAutostart().status()`, replace the target computation with:

```ts
      const execute = parsed.data.execute ?? '';
      const argumentsText = parsed.data.arguments ?? '';
      const target = parseWindowsTaskAction(execute, argumentsText, parsed.data.workingDirectory ?? '');
      if (!target) {
        return { enabled: true, target: null, problems: [`Task agentpager chạy lệnh không nhận ra: ${execute} ${argumentsText}`.trim()] };
      }
      return { enabled: true, target, problems: await targetProblems(target, deps.exists) };
```

- [ ] **Step 6: Update `packages/core/src/platform/autostart/macos.ts`**

In `buildLaunchAgentPlist`, replace the three `ProgramArguments` string lines with:

```ts
    ...[target.command, ...target.args].map((value) => `    ${string(value)}`),
```

In `status()`, the unloaded message loses its CLI-specific hint (each front end shows its own fix):

```ts
      if (printed.code !== 0) problems.push('LaunchAgent có file nhưng chưa được nạp.');
```

Replace `parseLaunchAgentPlist` with:

```ts
export function parseLaunchAgentPlist(text: string): AutostartTarget | null {
  const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  const workingDir = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text)?.[1];
  if (programArguments === undefined || workingDir === undefined) return null;
  const [command, ...args] = [...programArguments.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    xmlUnescape(match[1] ?? ''),
  );
  if (!command) return null;
  return { command, args, workingDir: xmlUnescape(workingDir), console: false };
}
```

- [ ] **Step 7: Update the CLI `packages/core/src/cli/commands/autostart.ts`**

```ts
import type { AutostartTarget } from '../../platform/autostart/types.js';
import type { CliDeps, Command } from '../types.js';

/** Autostart problems are front-end neutral; the CLI adds its own fix. */
export const AUTOSTART_FIX_HINT = 'Chạy lại "agentpager autostart on" để sửa.';

export function autostartTarget(deps: CliDeps): AutostartTarget {
  return { command: deps.nodePath, args: [deps.cliPath, 'daemon'], workingDir: deps.platform.homedir, console: true };
}

export const autostartCommand: Command = async (args, io, deps) => {
  switch (args.positionals[0]) {
    case 'on':
      for (const message of await deps.autostart.enable(autostartTarget(deps))) io.out(message);
      return 0;
    case 'off':
      for (const message of await deps.autostart.disable()) io.out(message);
      return 0;
    case 'status': {
      const status = await deps.autostart.status();
      io.out(`Tự khởi động: ${status.enabled ? 'bật' : 'tắt'}`);
      if (status.target) io.out(`Lệnh: ${[status.target.command, ...status.target.args].map((part) => `"${part}"`).join(' ')}`);
      for (const problem of status.problems) io.out(`⚠️ ${problem}`);
      if (status.problems.length > 0) io.out(AUTOSTART_FIX_HINT);
      return 0;
    }
    default:
      io.err('Cách dùng: agentpager autostart on|off|status');
      return 1;
  }
};
```

- [ ] **Step 8: Update the CLI test fakes and expectations**

In `packages/core/tests/cli/support.ts` replace `describeTarget` with:

```ts
  const describeTarget = (target: AutostartTarget): string =>
    `${target.command}|${target.args.join(' ')}|${target.workingDir}|${String(target.console)}`;
```

In `packages/core/tests/cli/setup.test.ts` and in `describe('autostart')` of `packages/core/tests/cli/commands.test.ts`, the enable expectation becomes:

```ts
      'enable:C:\\Program Files\\nodejs\\node.exe|C:\\npm\\node_modules\\agentpager\\dist\\cli\\main.js daemon|C:\\Users\\alex|true',
```

Replace the `it('shows the status and usage', …)` test in `commands.test.ts` with:

```ts
  it('shows the status and usage', async () => {
    const { deps, state } = await configured();
    state.autostartStatus = {
      enabled: true,
      target: { command: 'C:\\node.exe', args: ['C:\\cli.js', 'daemon'], workingDir: 'C:\\', console: true },
      problems: ['Không còn tìm thấy C:\\cli.js'],
    };
    const io = new FakeIo();
    await expect(runCli(['autostart', 'status'], io, deps)).resolves.toBe(0);
    expect(io.outs).toEqual([
      'Tự khởi động: bật',
      'Lệnh: "C:\\node.exe" "C:\\cli.js" "daemon"',
      '⚠️ Không còn tìm thấy C:\\cli.js',
      'Chạy lại "agentpager autostart on" để sửa.',
    ]);

    const usage = new FakeIo();
    await expect(runCli(['autostart'], usage, deps)).resolves.toBe(1);
    expect(usage.errs).toEqual(['Cách dùng: agentpager autostart on|off|status']);
  });
```

In `packages/core/src/cli/commands/status.ts`, import `AUTOSTART_FIX_HINT` from `./autostart.js` and after the autostart problem loop add:

```ts
    if (autostart.problems.length > 0) io.out(`  ${AUTOSTART_FIX_HINT}`);
```

In the `status` test of `commands.test.ts`, the fixture problem becomes `'Không còn tìm thấy C:\\old\\node.exe'` and the expected output gains `'  Chạy lại "agentpager autostart on" để sửa.'` right after `'  ⚠️ Không còn tìm thấy C:\\old\\node.exe'`.

- [ ] **Step 9: Run the core checks**

Run: `npm run check -w packages/core`
Expected: all suites pass (autostart suite, CLI suites).

- [ ] **Step 10: Commit and push**

```bash
git add -A packages/core
git commit -m "refactor: generic autostart target with a console flag"
git push origin main
```

---

### Task 4: `daemon.json` launcher, worker environment and package entry points

**Files:**
- Modify: `packages/core/src/daemon/daemonInfo.ts`, `packages/core/src/daemon/main.ts`, `packages/core/src/cli/deps.ts`, `packages/core/package.json`, `packages/core/tsconfig.build.json`
- Create: `packages/core/src/core/config/index.ts`, `packages/core/src/daemon/index.ts`, `packages/core/src/platform/index.ts`, `packages/core/src/providers/index.ts`
- Test: `packages/core/tests/daemon/ipc.test.ts` (daemon info section), `packages/core/tests/package/exports.test.ts`

**Interfaces:**
- Consumes: `control/index.ts` (Task 2), `AutostartTarget` (Task 3).
- Produces:
  - `interface DaemonLauncher { kind: 'cli' | 'app'; executable: string }`; `DaemonInfo.launcher?: DaemonLauncher`
  - `RunDaemonOptions.launcher: DaemonLauncher` (required) and `RunDaemonOptions.workerEnv?: Record<string, string>` (merged into the forked worker's environment)
  - Package entry points (all `import … from '@chiennguyen/agentpager/<entry>'`):
    - `./config`: everything from `schema.ts`, `ConfigStore`, `MISSING_CONFIG_MESSAGE`, `ConfigStoreDeps`
    - `./control`: everything from `control/daemon.ts` and `control/logFiles.ts`
    - `./daemon`: `runDaemon`, `RunDaemonOptions`, `readDaemonInfo`, `DaemonInfo`, `DaemonLauncher`, `ipcRequest`, `IpcError`, `IPC_COMMANDS`, `IpcCommand`, `IpcErrorCode`, `findPackageRoot`, `readPackageVersion`, `SupervisorStatus`, `WorkerState`
    - `./platform`: `appPaths`, `currentPlatform`, `AppPaths`, `PlatformInfo`, `createAutostart`, `defaultAutostartDeps`, `Autostart`, `AutostartDeps`, `AutostartStatus`, `AutostartTarget`, `stableExecutablePath`
    - `./providers`: `providerCatalog`, `findCatalogEntry`, `ProviderCatalogEntry`, `Detection`, `ModelOption`
    - `./package.json`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('daemon info file', …)` block in `packages/core/tests/daemon/ipc.test.ts`:

```ts
  it('stores where the daemon was launched from and still reads files without it', async () => {
    const withLauncher = { ...info('/tmp/a.sock', newToken()), launcher: { kind: 'app' as const, executable: 'C:\\agentpager\\agentpager.exe' } };
    await writeDaemonInfo(file, withLauncher, process.platform);
    await expect(readDaemonInfo(file)).resolves.toEqual(withLauncher);

    const withoutLauncher = info('/tmp/a.sock', newToken());
    await writeDaemonInfo(file, withoutLauncher, process.platform);
    await expect(readDaemonInfo(file)).resolves.toEqual(withoutLauncher);

    writeFileSync(file, JSON.stringify({ ...withoutLauncher, launcher: { kind: 'robot', executable: 'x' } }));
    await expect(readDaemonInfo(file)).resolves.toBeNull();
  });
```

Create `packages/core/tests/package/exports.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | { types: string; default: string }>;
};

describe('package entry points', () => {
  it('map every entry to a source barrel with matching types', () => {
    const entries = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
    expect(entries.map(([key]) => key)).toEqual(['./config', './control', './daemon', './platform', './providers']);
    for (const [, target] of entries) {
      if (typeof target === 'string') throw new Error('entry points must declare types');
      expect(target.types).toBe(target.default.replace(/\.js$/, '.d.ts'));
      const source = join(root, target.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
      expect(existsSync(source), source).toBe(true);
    }
  });

  it('expose what the desktop app imports', async () => {
    const config = await import('../../src/core/config/index.js');
    const control = await import('../../src/control/index.js');
    const daemon = await import('../../src/daemon/index.js');
    const platform = await import('../../src/platform/index.js');
    const providers = await import('../../src/providers/index.js');
    expect(Object.keys(config)).toEqual(expect.arrayContaining(['ConfigStore', 'ConfigError', 'validateConfig', 'normalizeUsername', 'maskToken', 'MISSING_CONFIG_MESSAGE', 'LOG_LEVELS']));
    expect(Object.keys(control)).toEqual(
      expect.arrayContaining(['startDaemon', 'stopDaemon', 'restartDaemon', 'readDaemonStatus', 'notifyUsersChanged', 'followLog', 'readLogTail', 'formatLogLine', 'lastDaemonFatal']),
    );
    expect(Object.keys(daemon)).toEqual(expect.arrayContaining(['runDaemon', 'readDaemonInfo', 'ipcRequest', 'IpcError', 'findPackageRoot', 'readPackageVersion']));
    expect(Object.keys(platform)).toEqual(expect.arrayContaining(['appPaths', 'currentPlatform', 'createAutostart', 'defaultAutostartDeps', 'stableExecutablePath']));
    expect(Object.keys(providers)).toEqual(expect.arrayContaining(['providerCatalog', 'findCatalogEntry']));
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/daemon/ipc.test.ts tests/package/exports.test.ts` (in `packages/core`)
Expected: FAIL — launcher is stripped by the schema; `exports` missing.

- [ ] **Step 3: Add `launcher` to `packages/core/src/daemon/daemonInfo.ts`**

```ts
export interface DaemonLauncher {
  kind: 'cli' | 'app';
  /** The CLI entry file or the desktop app executable that started the daemon. */
  executable: string;
}

/** Written by the running supervisor; the token keeps other local users from controlling the daemon. */
export interface DaemonInfo {
  pid: number;
  startedAt: string;
  ipc: { path: string };
  token: string;
  /** Absent in files written by agentpager 0.1.x. */
  launcher?: DaemonLauncher;
}
```

and extend the schema:

```ts
const daemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  ipc: z.object({ path: z.string().min(1) }),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  launcher: z.object({ kind: z.enum(['cli', 'app']), executable: z.string().min(1) }).optional(),
});
```

- [ ] **Step 4: Add `launcher` and `workerEnv` to `packages/core/src/daemon/main.ts`**

```ts
export interface RunDaemonOptions {
  paths: AppPaths;
  platform: PlatformInfo;
  packageRoot: string;
  /** Mirror logs and worker output to this terminal instead of running detached. */
  foreground: boolean;
  /** Recorded in daemon.json so a UI can show where the running bot came from. */
  launcher: DaemonLauncher;
  /** Extra environment for the forked worker (the desktop app sets ELECTRON_RUN_AS_NODE). */
  workerEnv?: Record<string, string>;
}
```

Import `type DaemonLauncher` from `./daemonInfo.js`. In `forkWorker`, set:

```ts
    env: { ...process.env, AGENTPAGER_HOME: options.paths.root, ...options.workerEnv },
```

In `runDaemon`, write the launcher:

```ts
  await writeDaemonInfo(
    paths.daemonInfo,
    { pid: process.pid, startedAt: new Date().toISOString(), ipc: { path: paths.ipc }, token, launcher: options.launcher },
    platform.platform,
  );
```

- [ ] **Step 5: Pass the CLI launcher in `packages/core/src/cli/deps.ts`**

```ts
    runDaemon: (foreground) =>
      runDaemon({ paths, platform, packageRoot: env.packageRoot, foreground, launcher: { kind: 'cli', executable: env.cliPath } }),
```

- [ ] **Step 6: Create the barrels**

`packages/core/src/core/config/index.ts`:

```ts
export * from './schema.js';
export { ConfigStore, MISSING_CONFIG_MESSAGE, type ConfigStoreDeps } from './store.js';
```

`packages/core/src/daemon/index.ts`:

```ts
export { readDaemonInfo, type DaemonInfo, type DaemonLauncher } from './daemonInfo.js';
export { IPC_COMMANDS, IpcError, ipcRequest, type IpcCommand, type IpcErrorCode } from './ipc.js';
export { runDaemon, type RunDaemonOptions } from './main.js';
export { findPackageRoot, readPackageVersion } from './packageRoot.js';
export type { SupervisorStatus, WorkerState } from './supervisor.js';
```

`packages/core/src/platform/index.ts`:

```ts
export { createAutostart, defaultAutostartDeps } from './autostart/index.js';
export type { Autostart, AutostartDeps, AutostartStatus, AutostartTarget } from './autostart/types.js';
export { appPaths, currentPlatform, type AppPaths, type PlatformInfo } from './paths.js';
export { stableExecutablePath } from './realPath.js';
```

`packages/core/src/providers/index.ts`:

```ts
export { findCatalogEntry, providerCatalog } from './registry.js';
export type { Detection, ModelOption, ProviderCatalogEntry } from './types.js';
```

- [ ] **Step 7: Emit declarations and declare the entry points**

In `packages/core/tsconfig.build.json` add `"declaration": true` to `compilerOptions`. In `packages/core/package.json` add after `"bin"`:

```json
  "exports": {
    "./config": { "types": "./dist/core/config/index.d.ts", "default": "./dist/core/config/index.js" },
    "./control": { "types": "./dist/control/index.d.ts", "default": "./dist/control/index.js" },
    "./daemon": { "types": "./dist/daemon/index.d.ts", "default": "./dist/daemon/index.js" },
    "./platform": { "types": "./dist/platform/index.d.ts", "default": "./dist/platform/index.js" },
    "./providers": { "types": "./dist/providers/index.d.ts", "default": "./dist/providers/index.js" },
    "./package.json": "./package.json"
  },
```

- [ ] **Step 8: Run the checks and build**

Run: `npm run check`
Expected: green; `packages/core/dist/control/index.d.ts` exists after the build step.

Run: `node --input-type=module -e "const m = await import('@chiennguyen/agentpager/control'); console.log(typeof m.startDaemon)"`
Expected: `function`

- [ ] **Step 9: Commit and push**

```bash
git add -A packages/core
git commit -m "feat: daemon launcher, worker environment and package entry points"
git push origin main
```

### Task 5: Desktop scaffold and the Electron risk spike (gate)

The spec (section 12) requires the three Electron risks to be proven before any screen is built. This task
builds the smallest app that can prove them: a window that shows a placeholder, and `<exe> --daemon` running
the core daemon from a packaged, unsigned build.

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/electron-builder.yml`,
  `apps/desktop/tsconfig.json`, `apps/desktop/src/renderer/tsconfig.json`, `apps/desktop/vitest.config.ts`,
  `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/src/main/launchMode.ts`, `apps/desktop/src/main/daemonProcess.ts`, `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/preload/index.ts` (empty bridge for now), `apps/desktop/src/renderer/index.html`,
  `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/tests/main/launchMode.test.ts`, `apps/desktop/tests/main/daemonProcess.test.ts`,
  `apps/desktop/tests/smoke/app.smoke.ts`
- Modify: `eslint.config.js` (desktop globs), root `package.json` (no change to scripts; the workspace glob already includes `apps/*`)
- Record: `lessons.md` — spike results (what worked, what needed a fallback)

**Interfaces:**
- Consumes: `@chiennguyen/agentpager/daemon` (`runDaemon`, `findPackageRoot`), `@chiennguyen/agentpager/platform`
  (`appPaths`, `currentPlatform`), `DaemonLauncher` (Task 4).
- Produces:
  - `type LaunchMode = { kind: 'daemon' } | { kind: 'gui'; hidden: boolean }`; `parseLaunchMode(argv: readonly string[]): LaunchMode`
  - `interface AppProcessInfo { execPath: string; isPackaged: boolean; appPath: string }`
  - `daemonCommand(info: AppProcessInfo): { command: string; args: string[] }` — packaged `[execPath, ['--daemon']]`, dev `[execPath, [appPath, '--daemon']]`
  - `runAppDaemon(info: AppProcessInfo): Promise<number>` — `runDaemon` with `launcher: { kind: 'app', executable: execPath }`, `workerEnv: { ELECTRON_RUN_AS_NODE: '1' }`, `packageRoot` = folder of `@chiennguyen/agentpager/package.json`
  - Build outputs: `apps/desktop/out/{main,preload,renderer}`, unpacked app in `apps/desktop/release/<platform>-unpacked`

- [ ] **Step 1: Create `apps/desktop/package.json`**

```json
{
  "name": "@agentpager/desktop",
  "private": true,
  "version": "0.1.0",
  "description": "agentpager desktop app",
  "license": "MIT",
  "author": "nguyenkechien",
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "pack": "electron-vite build && electron-builder --dir",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/renderer/tsconfig.json",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "npm run typecheck && npm run lint && npm run test",
    "smoke": "playwright test"
  },
  "dependencies": {
    "@chiennguyen/agentpager": "0.1.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "electron": "44.3.0",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "jsdom": "30.0.1",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "vite": "7.3.6"
  }
}
```

React is a devDependency: the renderer is bundled by Vite, so it must not be copied into the app's `node_modules`.

- [ ] **Step 2: Create `apps/desktop/electron.vite.config.ts`**

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Runtime dependencies (the agentpager core, zod) stay in node_modules: the core forks its worker from its own files.
    build: { externalizeDeps: true },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
});
```

- [ ] **Step 3: Create the TypeScript projects**

`apps/desktop/tsconfig.json` (main, preload, shared, main tests, smoke test, config files):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["src/main", "src/preload", "src/shared", "tests/main", "tests/smoke", "electron.vite.config.ts", "vitest.config.ts", "playwright.config.ts"]
}
```

`apps/desktop/src/renderer/tsconfig.json`:

```json
{
  "extends": "../../../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "types": [],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": [".", "../shared", "../../tests/renderer"]
}
```

- [ ] **Step 4: Write the failing tests for launch mode and daemon command**

`apps/desktop/tests/main/launchMode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseLaunchMode } from '../../src/main/launchMode.js';

describe('parseLaunchMode', () => {
  it('routes --daemon before anything else, in packaged and dev argv shapes', () => {
    expect(parseLaunchMode(['C:\\agentpager\\agentpager.exe', '--daemon'])).toEqual({ kind: 'daemon' });
    expect(parseLaunchMode(['C:\\electron.exe', 'D:\\Projects\\agentpager\\apps\\desktop', '--daemon'])).toEqual({ kind: 'daemon' });
  });

  it('starts the GUI, hidden only with --hidden', () => {
    expect(parseLaunchMode(['/Applications/agentpager.app/Contents/MacOS/agentpager'])).toEqual({ kind: 'gui', hidden: false });
    expect(parseLaunchMode(['agentpager.exe', '--hidden'])).toEqual({ kind: 'gui', hidden: true });
  });

  it('ignores look-alike arguments', () => {
    expect(parseLaunchMode(['agentpager.exe', '--daemonize', 'daemon'])).toEqual({ kind: 'gui', hidden: false });
  });
});
```

`apps/desktop/tests/main/daemonProcess.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { daemonCommand } from '../../src/main/daemonProcess.js';

describe('daemonCommand', () => {
  it('runs the packaged executable with --daemon', () => {
    expect(daemonCommand({ execPath: 'C:\\agentpager\\agentpager.exe', isPackaged: true, appPath: 'C:\\agentpager\\resources\\app.asar' })).toEqual({
      command: 'C:\\agentpager\\agentpager.exe',
      args: ['--daemon'],
    });
  });

  it('passes the app folder to the electron binary in development', () => {
    expect(daemonCommand({ execPath: 'D:\\node_modules\\electron\\dist\\electron.exe', isPackaged: false, appPath: 'D:\\apps\\desktop' })).toEqual({
      command: 'D:\\node_modules\\electron\\dist\\electron.exe',
      args: ['D:\\apps\\desktop', '--daemon'],
    });
  });
});
```

`apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'main', include: ['tests/main/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'renderer',
          include: ['tests/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/renderer/setup.ts'],
        },
      },
    ],
  },
});
```

Until Task 10 adds renderer tests, create `apps/desktop/tests/renderer/setup.ts` with:

```ts
import '@testing-library/jest-dom/vitest';
```

Run: `npm install` (root), then `npx vitest run --project main` in `apps/desktop`
Expected: FAIL — modules `launchMode.js` / `daemonProcess.js` not found.

- [ ] **Step 5: Implement `apps/desktop/src/main/launchMode.ts`**

```ts
export type LaunchMode = { kind: 'daemon' } | { kind: 'gui'; hidden: boolean };

/** `--daemon` wins over everything: that process must never open a window, a tray or take the single-instance lock. */
export function parseLaunchMode(argv: readonly string[]): LaunchMode {
  if (argv.includes('--daemon')) return { kind: 'daemon' };
  return { kind: 'gui', hidden: argv.includes('--hidden') };
}
```

- [ ] **Step 6: Implement `apps/desktop/src/main/daemonProcess.ts`**

```ts
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runDaemon } from '@chiennguyen/agentpager/daemon';
import { appPaths, currentPlatform } from '@chiennguyen/agentpager/platform';

export interface AppProcessInfo {
  execPath: string;
  isPackaged: boolean;
  /** `app.getAppPath()`: the app folder in development, `resources/app.asar` when packaged. */
  appPath: string;
}

/** The command that runs this app as the agentpager daemon, used for Start and for autostart. */
export function daemonCommand(info: AppProcessInfo): { command: string; args: string[] } {
  return info.isPackaged ? { command: info.execPath, args: ['--daemon'] } : { command: info.execPath, args: [info.appPath, '--daemon'] };
}

/** The installed core package: holds guard-rules.default.json and its version. */
export function corePackageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('@chiennguyen/agentpager/package.json'));
}

export function runAppDaemon(info: AppProcessInfo): Promise<number> {
  const platform = currentPlatform();
  return runDaemon({
    paths: appPaths(platform),
    platform,
    packageRoot: corePackageRoot(),
    foreground: false,
    launcher: { kind: 'app', executable: info.execPath },
    // fork() uses this executable (Electron); the worker must run as plain Node.
    workerEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
}
```

- [ ] **Step 7: Implement the spike entry `apps/desktop/src/main/index.ts`**

```ts
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { runAppDaemon } from './daemonProcess.js';
import { parseLaunchMode } from './launchMode.js';

const mode = parseLaunchMode(process.argv);

if (mode.kind === 'daemon') {
  app.dock?.hide();
  runAppDaemon({ execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath() }).then(
    (code) => {
      app.exit(code);
    },
    (error: unknown) => {
      console.error('agentpager daemon failed:', error);
      app.exit(1);
    },
  );
} else {
  void app.whenReady().then(() => {
    const window = new BrowserWindow({
      width: 960,
      height: 680,
      show: !mode.hidden,
      webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true },
    });
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  });
}
```

`apps/desktop/src/preload/index.ts`:

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('agentpager', {});
```

`apps/desktop/src/renderer/index.html`:

```html
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" />
    <title>agentpager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(
  <StrictMode>
    <h1>agentpager</h1>
  </StrictMode>,
);
```

- [ ] **Step 8: Create `apps/desktop/electron-builder.yml`**

```yaml
appId: io.github.nguyenkechien.agentpager
productName: agentpager
electronVersion: 44.3.0
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
asar: true
asarUnpack:
  # The worker is forked from these files and the Claude Code binary is executed: both need real files.
  - node_modules/@chiennguyen/agentpager/**
  - node_modules/@anthropic-ai/claude-agent-sdk-*/**
  # pino transports run in worker threads loaded by file path.
  - node_modules/pino/**
  - node_modules/pino-roll/**
  - node_modules/thread-stream/**
  - node_modules/pino-abstract-transport/**
  - node_modules/sonic-boom/**
win:
  target: dir
mac:
  target: dir
  identity: null
```

- [ ] **Step 9: Write the packaged smoke test `apps/desktop/tests/smoke/app.smoke.ts` and `playwright.config.ts`**

`apps/desktop/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests/smoke', testMatch: '*.smoke.ts', timeout: 90_000, workers: 1 });
```

`apps/desktop/tests/smoke/app.smoke.ts`:

```ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const releaseDir = join(import.meta.dirname, '..', '..', 'release');

function packagedExecutable(): string {
  if (process.platform === 'win32') return join(releaseDir, 'win-unpacked', 'agentpager.exe');
  const macDir = readdirSync(releaseDir).find((name) => name.startsWith('mac'));
  if (!macDir) throw new Error(`no mac build in ${releaseDir}`);
  return join(releaseDir, macDir, 'agentpager.app', 'Contents', 'MacOS', 'agentpager');
}

function runDaemonProcess(home: string): Promise<number | null> {
  const child = spawn(packagedExecutable(), ['--daemon'], { env: { ...process.env, AGENTPAGER_HOME: home }, stdio: 'ignore' });
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
}

test('the packaged app opens a window', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentpager-smoke-'));
  const app = await electron.launch({ executablePath: packagedExecutable(), env: { ...process.env, AGENTPAGER_HOME: home } });
  const window = await app.firstWindow();
  await expect(window.locator('h1')).toHaveText('agentpager');
  await app.close();
});

test('--daemon without a config forks the worker, logs the fatal error, exits 1 and removes daemon.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentpager-smoke-'));
  expect(await runDaemonProcess(home)).toBe(1);
  const supervisorLog = readFileSync(join(home, 'logs', 'supervisor.log'), 'utf8');
  expect(supervisorLog).toContain('worker reported a fatal error');
  expect(supervisorLog).toContain('Chưa có cấu hình');
  expect(existsSync(join(home, 'daemon.json'))).toBe(false);
});

test('--daemon with a config runs the worker logger (pino-roll transport) from the packaged app', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentpager-smoke-'));
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      telegram: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVwxyz' },
      allowedUsers: [{ username: 'example_user', userId: null, pairedAt: null }],
      projectsRoot: home,
      idleTimeoutMinutes: 60,
      logLevel: 'info',
      agent: { provider: 'claude-code', executable: null, defaultModel: null, defaultEffort: null },
    }),
  );
  const exited = runDaemonProcess(home);
  const logsDir = join(home, 'logs');
  await expect
    .poll(() => (existsSync(logsDir) ? readdirSync(logsDir).filter((name) => name.startsWith('agentpager.')).length : 0), { timeout: 30_000 })
    .toBeGreaterThan(0);
  // The fake token makes Telegram answer 401 (fatal, exit 1). Without network the worker keeps restarting;
  // stop it through IPC so the test does not depend on connectivity.
  const { ipcRequest, readDaemonInfo } = await import('@chiennguyen/agentpager/daemon');
  const info = await readDaemonInfo(join(home, 'daemon.json'));
  if (info) await ipcRequest(info, 'stop').catch(() => undefined);
  expect([0, 1]).toContain(await exited);
});
```

The `.catch(() => undefined)` above is deliberate: the daemon may already have exited on the 401 between reading
`daemon.json` and sending `stop`; the assertion that follows checks the exit either way.

- [ ] **Step 10: Add the desktop globs to `eslint.config.js`**

After the `strictTypeChecked` block add:

```js
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'apps/desktop/tests/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },
```

- [ ] **Step 11: Run unit checks, build, package and run the smoke**

Run: `npm run check`
Expected: core and desktop checks green (desktop: 5 main tests).

Run: `npm run pack -w apps/desktop`
Expected: `apps/desktop/release/win-unpacked/agentpager.exe` exists; `resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` exists.

Run: `npx playwright test` (in `apps/desktop`)
Expected: 3 passed.

- [ ] **Step 12: Verify the windowless daemon by hand (Windows)** — with the user's bot untouched (temporary home):

```powershell
$env:AGENTPAGER_HOME = "$env:TEMP\agentpager-spike"
& .\apps\desktop\release\win-unpacked\agentpager.exe --daemon
```

Expected: no window or console appears; the command returns; `logs\supervisor.log` shows the fatal "no config" line.

- [ ] **Step 13: Record the spike result in `lessons.md`** — one bullet per risk (fork as Node, windowless `--daemon`,
  asar + pino transports + SDK binary) with what was observed and any fallback that was needed. If a risk failed,
  stop and apply the fallback from spec section 12 before continuing (`utilityProcess.fork` for the worker, or
  additional `asarUnpack` entries), updating this task's code and tests.

- [ ] **Step 14: Commit and push**

```bash
git add -A apps/desktop eslint.config.js package-lock.json lessons.md
git commit -m "feat(desktop): Electron scaffold running the core daemon with --daemon"
git push origin main
```

- [x] **Step 15: Spike outcome** — all three risks passed on Windows without a fallback (details in `lessons.md`).
  Two core fixes came out of it: a separate Windows pipe per overridden `AGENTPAGER_HOME`, and startup failures
  logged synchronously to `supervisor.log`. Tasks 6–15 keep the files, interfaces and acceptance criteria below;
  each task's steps (test files, commands, commit) are recorded under it when it is implemented, and interface
  changes found while implementing are noted in the task.

---

### Task 6: Shared API types and main-process services

**Files:**
- Create: `apps/desktop/src/shared/api.ts`, `apps/desktop/src/main/services/results.ts`, `apps/desktop/src/main/services/configService.ts`,
  `apps/desktop/src/main/services/daemonService.ts`, `apps/desktop/src/main/services/autostartService.ts`, `apps/desktop/src/main/services/agentService.ts`
- Test: `apps/desktop/tests/main/services/{results,configService,daemonService,autostartService}.test.ts`

**Interfaces:**
- Consumes: core `ConfigStore`, `ConfigError`, `maskToken`, `normalizeUsername`, `validateConfig`, `LOG_LEVELS`; core control
  (`readDaemonStatus`, `startDaemon`, `stopDaemon`, `restartDaemon`, `notifyUsersChanged`, `lastDaemonFatal`); `createAutostart`;
  `providerCatalog` + `Detection`; `daemonCommand` (Task 5).
- Produces (`src/shared/api.ts`):
  - `type ApiErrorCode = 'invalid_input' | 'invalid_config' | 'missing_config' | 'not_running' | 'timeout' | 'unauthorized' | 'fatal' | 'network' | 'invalid_token' | 'failed'`
  - `interface ApiError { code: ApiErrorCode; message: string; fieldErrors?: Record<string, string[]> }`
  - `type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }`
  - `type BadgeState = 'running' | 'starting' | 'restarting' | 'stopped' | 'error' | 'unresponsive' | 'disconnected'`
  - `interface DaemonView { badge: BadgeState; pid: number | null; startedAt: string | null; workerPid: number | null; restarts: number; botUsername: string | null; provider: string | null; lastError: string | null; launcher: { kind: 'cli' | 'app'; executable: string } | null }`
  - `interface AutostartView { enabled: boolean; target: { command: string; args: string[] } | null; ownedByThisApp: boolean; problems: string[] }`
  - `interface UserView { username: string; paired: boolean; pairedAt: string | null }`
  - `interface SettingsView { botTokenMasked: string; projectsRoot: string; idleTimeoutMinutes: number; logLevel: LogLevelName; agent: { provider: string; executable: string | null; defaultModel: string | null; defaultEffort: string | null }; trayAtLogin: boolean }`
  - `type ConfigView = { state: 'missing' } | { state: 'valid'; settings: SettingsView; users: UserView[] } | { state: 'invalid'; issues: string[]; fieldErrors: Record<string, string[]>; draft: Partial<SettingsView> | null }`
  - `interface SettingsPatch { botToken?: string; projectsRoot?: string; idleTimeoutMinutes?: number; logLevel?: LogLevelName; agent?: Partial<SettingsView['agent']>; trayAtLogin?: boolean }`
  - `interface WizardInput { botToken: string; usernames: string[]; projectsRoot: string; agentExecutable: string | null; idleTimeoutMinutes: number; autostart: boolean; trayAtLogin: boolean }`
  - `interface ProviderView { id: string; displayName: string; models: { id: string; label: string }[]; efforts: string[] }`
  - `interface AgentDetectionView { executable: string | null; version: string | null; problems: string[] }`
  - `type LogSource = 'worker' | 'supervisor'`; `interface LogLine { time: string | null; level: string; message: string; extra: string | null; raw: string }`
  - `interface AgentpagerApi` — the preload surface from spec 8.1 (`config.load/save/runWizard/verifyToken`, `users.add/remove/unpair`,
    `daemon.status/start/stop/restart`, `autostart.get/set`, `agent.detect/providers`, `dialog.pickFolder/pickExecutable`,
    `shell.openLogFolder/openConfigFile`, `onStatus`, `onConfigChanged`, `logs.subscribe(source, onLines) → () => void`)
- `results.ts`: `ok<T>(data)`, `fail(code, message, fieldErrors?)`, `fieldErrorsFromIssues(issues: string[]): Record<string, string[]>`
  (prefix before the first `:`; `telegram.botToken` → `botToken`, `agent.*` kept, `allowedUsers[n].*` → `allowedUsers`), `toApiError(error: unknown): ApiError`
  (`ConfigError` → `invalid_config` + fieldErrors, `MISSING_CONFIG_MESSAGE` → `missing_config`, `IpcError` codes → same code, else `failed`).
- `daemonService.ts`: `toDaemonView(status: SupervisorStatus | null, info: DaemonInfo | null, fatalSinceStart: string | null, ipcError: IpcErrorCode | null): DaemonView`
  mapping: `ipcError 'timeout'` → `unresponsive`; `'unauthorized'` → `disconnected`; `null` status + fatal → `error`; `null` → `stopped`;
  workerState `starting` → `starting`, `restarting` → `restarting` (or `error` when `lastError` set and restarts > 0 and state `restarting`),
  `stopped` → `error` when `lastError` else `stopped`, `running` → `running`.
- `configService.ts`: `load(): Promise<ConfigView>` (raw best-effort parse for `invalid`), `save(patch, current)` (only changed fields, via `configStore.update`),
  `runWizard(input)` (writes a full config; refuses when a config exists unless `overwrite`), `verifyToken(token)` → `{ username }` or `network` / `invalid_token`,
  `addUser/removeUser/unpairUser` + users-changed notification.
- `autostartService.ts`: `get(): Promise<AutostartView>` (`ownedByThisApp` when `target.command` equals the app's daemon command), `set(enabled)`.

**Acceptance (tests):** field-error mapping for every issue prefix the core produces; token never returned unmasked by `load`; `save` sends only changed
fields and a changed token only when provided; wizard refuses to overwrite; `verifyToken` distinguishes `GrammyError 401` from network errors;
every `toDaemonView` branch above; autostart target equals `daemonCommand` + `console: false` + homedir; ownership detection; users actions call
the reload notification and report `failed` without throwing.

**Interface changes while implementing:** expected failures are thrown as `ApiFailure` (carrying an `ApiError`) and converted by
`toApiError`, so services return plain data; `ApiErrorCode` gains `config_exists`; the fallback field is `form`; `SettingsView` has no
`trayAtLogin` — the login item is its own `loginItem.get/set` API (it is an OS setting, not config); `ReloadOutcome` gains `unchanged`
(unpairing an unpaired user); `ConfigService` takes `checkToken(token) → TokenCheck` (`valid` / `invalid` / `network`) so Telegram error
classification lives in the wiring; `AgentService.detect(provider, executable)`.

**Steps (done):**
- [x] Tests: `tests/main/services/{results,configService,daemonService,autostartService,agentService}.test.ts` with `tests/main/support/fakeCatalog.ts` (config tests use a real `ConfigStore` in a temp folder).
- [x] Code: `src/shared/api.ts`, `src/main/services/{results,configService,daemonService,autostartService,agentService}.ts`.
- [x] `npm run check -w apps/desktop` → typecheck, lint, 7 files / 50 tests green.
- [x] Commit `feat(desktop): main-process services` and push.

---

### Task 7: IPC handlers, input schemas and the preload bridge

**Files:**
- Create: `apps/desktop/src/main/ipc/channels.ts`, `apps/desktop/src/main/ipc/schemas.ts`, `apps/desktop/src/main/ipc/handlers.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Test: `apps/desktop/tests/main/ipc/handlers.test.ts`

**Interfaces:**
- Consumes: Task 6 services and `AgentpagerApi`.
- Produces: `CHANNELS` (one string per API method, e.g. `'config:load'`), `registerHandlers(ipc: IpcMainLike, services: Services, isTrustedSender: (frame: WebFrameLike) => boolean): void`
  where `IpcMainLike = { handle(channel: string, listener: (event: { senderFrame: WebFrameLike | null }, ...args: unknown[]) => Promise<unknown>): void }`;
  preload `window.agentpager: AgentpagerApi` built from `ipcRenderer.invoke` and `ipcRenderer.on` with listener removal.

**Acceptance (tests):** each channel validates its arguments with zod and returns `invalid_input` for bad input without calling the service; a
foreign sender (frame URL not the app's renderer) gets `unauthorized`; a service that throws becomes `{ ok: false }` via `toApiError`; every
`AgentpagerApi` method has exactly one channel (checked by comparing `CHANNELS` keys with a typed method list).

**Steps:** written in Step 15 of Task 5.

---

### Task 8: Live updates — status poller, config watcher, log stream

**Files:**
- Create: `apps/desktop/src/main/live/statusPoller.ts`, `apps/desktop/src/main/live/configWatcher.ts`, `apps/desktop/src/main/live/logStream.ts`
- Test: `apps/desktop/tests/main/live/{statusPoller,configWatcher,logStream}.test.ts`

**Interfaces:**
- Produces:
  - `createStatusPoller({ read: () => Promise<DaemonView>, intervalMs = 2000, onChange: (view) => void, setInterval, clearInterval }) → { start(): void; stop(): void; refresh(): Promise<DaemonView> }`
  - `createConfigWatcher({ dir: string; file: 'config.json'; debounceMs = 300; watch: (dir, listener) => { close(): void }; onChange: () => void }) → { close(): void }`
  - `createLogStream({ follow: (source, onLine) => Promise<() => void>; readTail: (source, lines) => Promise<LogLine[]>; batchMs = 250; maxInitialLines = 2000; send: (lines: LogLine[]) => void }) → { start(source): Promise<void>; stop(): void }`

**Acceptance (tests, fake timers):** poller pushes only when the view changes (deep compare) and never overlaps reads; watcher fires once per burst and only for `config.json`;
log stream sends the tail first, batches follow lines every 250 ms, stops the follow on `stop()` and on source change.

**Steps:** written in Step 15 of Task 5.

---

### Task 9: App shell — window, tray, single instance, login item, crash handling

**Files:**
- Create: `apps/desktop/src/main/shell/trayModel.ts`, `apps/desktop/src/main/shell/trayIcon.ts`, `apps/desktop/src/main/shell/desktopLog.ts`, `apps/desktop/src/main/shell/appShell.ts`
- Modify: `apps/desktop/src/main/index.ts` (GUI branch uses `appShell`)
- Test: `apps/desktop/tests/main/shell/{trayModel,trayIcon,desktopLog}.test.ts`

**Interfaces:**
- Produces: `trayModel(view: DaemonView | null): { color: 'green' | 'grey' | 'red' | 'amber'; tooltip: string; statusLine: string; items: TrayItem[] }` with items
  `open`, `start` / `stop` (by state), `restart` (only while running), `quit` labelled "Thoát app (bot vẫn chạy)"; `circleBitmap(color, size): Buffer` (RGBA);
  `createDesktopLog(logsDir) → { error(context: string, error: unknown): void }` writing `desktop.log`; `startAppShell({ hidden })`.

**Acceptance:** tray model per badge; bitmap size and corner transparency; desktop log line format. Shell behaviours (close hides and shows the one-time
notice, second launch focuses, `--hidden` shows tray only, `render-process-gone` reloads once then shows a message, `uncaughtException` → desktop.log + dialog,
macOS Dock icon only while the window is visible) are verified in Task 15's smoke test and Task 16's live check.

**Steps:** written in Step 15 of Task 5.

---

### Task 10: Renderer foundation and the Trạng thái screen

**Files:**
- Create: `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/api.ts`, `apps/desktop/src/renderer/hooks/{useDaemon,useConfig,useAsyncAction}.ts`,
  `apps/desktop/src/renderer/components/{Sidebar,Badge,Button,Toggle,Banner,Toast,Field}.tsx`, `apps/desktop/src/renderer/screens/StatusScreen.tsx`,
  `apps/desktop/src/renderer/styles.css`
- Modify: `apps/desktop/src/renderer/main.tsx`
- Test: `apps/desktop/tests/renderer/fakeApi.ts`, `apps/desktop/tests/renderer/{App,StatusScreen}.test.tsx`

**Acceptance:** App shows the wizard when `config.load` is `missing`, the main layout otherwise; sidebar switches Trạng thái · Người dùng · Cài đặt · Log;
Status shows every badge label from spec 7.2, details (bot, pid, uptime, restarts, last error, agent path + version, launcher text), Start disabled while
a daemon runs, progress while waiting, fatal message with "Đổi token" for the invalid-token fatal, autostart toggle reverting with a toast on failure,
"Sửa tự khởi động" for problems and "Chuyển tự khởi động sang app này" when not owned; light/dark via `prefers-color-scheme`.

**Steps:** written in Step 15 of Task 5.

---

### Task 11: Wizard

**Files:** Create `apps/desktop/src/renderer/screens/wizard/{Wizard,TokenStep,UsersStep,ProjectsStep,AgentStep,IdleStep,FinishStep,PairingStep}.tsx`; Test `apps/desktop/tests/renderer/Wizard.test.tsx`.

**Acceptance:** the seven steps of spec 7.1 with Back/Next; token check messages ("✅ @bot", "Không kết nối được Telegram" with continue-after-confirm, "Token không hợp lệ");
username chips normalised and rejected with the core message; projects default + picker + must exist; agent detection with warning and file picker;
idle minutes integer ≥ 1; finish toggles both on; "Lưu & chạy bot" calls `config.runWizard` then `daemon.start` and shows start errors; pairing flips each
username to "✅ đã ghép" on `onConfigChanged`; "Xong" opens the main window.

**Steps:** written in Step 15 of Task 5.

---

### Task 12: Người dùng

**Files:** Create `apps/desktop/src/renderer/screens/UsersScreen.tsx`; Test `apps/desktop/tests/renderer/UsersScreen.test.tsx`.

**Acceptance:** list with "đã ghép (date)" / "chờ ghép"; add validates and shows the core error; remove asks for confirmation and shows the core's last-user error;
unpair; a `failed` reload result shows a warning banner with Restart.

**Steps:** written in Step 15 of Task 5.

---

### Task 13: Cài đặt

**Files:** Create `apps/desktop/src/renderer/screens/SettingsScreen.tsx`; Test `apps/desktop/tests/renderer/SettingsScreen.test.tsx`.

**Acceptance:** fields of spec 7.4 with provider models/efforts from `agent.providers`; "Đổi token" reveals an input; "Lưu" shows field errors under each field;
"Restart để áp dụng" banner when a daemon runs; invalid config prefilled from the draft with the issue banner; unparseable config offers "Mở file cấu hình" /
"Chạy lại wizard" (confirm before overwrite); config changed elsewhere with unsaved edits shows "Tải lại" / "Giữ bản đang sửa".

**Steps:** written in Step 15 of Task 5.

---

### Task 14: Log

**Files:** Create `apps/desktop/src/renderer/screens/LogScreen.tsx`, `apps/desktop/src/renderer/logBuffer.ts`; Test `apps/desktop/tests/renderer/{LogScreen.test.tsx,logBuffer.test.ts}`.

**Acceptance:** keeps the last 2,000 lines; tabs worker / supervisor; level filter Tất cả / Info / Warn+ / Error; search; "Tạm dừng cuộn"; extra fields collapsible;
"Mở thư mục log"; empty state "Chưa có log" with Start; unsubscribes on unmount and tab change.

**Steps:** written in Step 15 of Task 5.

---

### Task 15: Packaged smoke, CI desktop job and docs

**Files:** Modify `apps/desktop/tests/smoke/app.smoke.ts` (wizard visible instead of the placeholder heading), `.github/workflows/ci.yml` (desktop job),
`README.md`, `packages/core/README.md` (link to the app), `CLAUDE.md`, `lessons.md`.

**Acceptance:** CI `desktop` job on windows-latest and macos-latest: `npm ci` → `npm run build -w packages/core` → `npm run check -w apps/desktop` → `npm run pack -w apps/desktop`
→ `npx playwright test` (in `apps/desktop`) green; README documents dev/build of the app (Vietnamese); CLAUDE.md lists the desktop architecture.

**Steps:** written in Step 15 of Task 5.

---

### Task 16: Live verification on Windows (with the user)

Not code. With the user at their machine, and only after they agree to stop their npm-installed bot for the test:
1. Build the unpacked app (`npm run pack -w apps/desktop`) and launch `release\win-unpacked\agentpager.exe`.
2. The existing config shows the main window (no wizard); Status reads the running bot, launcher "chạy từ npm CLI".
3. Stop from the app → Start from the app → launcher "chạy từ app"; Restart; tray colours and menu.
4. Autostart: "Chuyển tự khởi động sang app này" → Task Scheduler action is `agentpager.exe --daemon`; sign out/in (user) → bot runs windowless.
5. A Claude turn over Telegram (user sends the message) → reply arrives; Log shows it live.
6. Wizard on a temporary `AGENTPAGER_HOME` (no real token entered by Claude).
7. Restore the user's preferred setup (`agentpager autostart on` from their terminal if they want the CLI install back).

Findings go to `lessons.md`; fixes follow the normal TDD loop.

---

## Self-review

- Spec coverage: §4 layout → Task 1; §5.1 → Task 2; §5.2 → Task 3; §5.3–5.4 → Task 4; §6 processes → Tasks 5, 9; §7.1 → Task 11; §7.2 → Task 10; §7.3 → Task 12;
  §7.4 → Task 13; §7.5 → Task 14; §7.6 → Task 9; §8.1 → Tasks 6–7; §8.2 → Task 6; §8.3 → Task 8; §8.4 → Task 6 (`toDaemonView`); §9 → Tasks 6, 9, 10–13;
  §10 → tests in every task, smoke in Tasks 5 and 15, live in Task 16; §11 → Tasks 5, 15; §12 → Task 5 gate.
- Tasks 6–15 name their files, interfaces and acceptance criteria now; their step-by-step code is written after the Task 5 spike (Task 5 Step 15),
  because the build layout and fork mechanism it proves decide that code.
- Names used across tasks: `DaemonControlDeps`, `StartResult`, `WorkerResult`, `StopResult`, `UsersChangedResult` (Task 2); `AutostartTarget.command/args/workingDir/console`
  (Task 3); `DaemonLauncher`, `RunDaemonOptions.launcher/workerEnv` (Task 4); `parseLaunchMode`, `daemonCommand`, `runAppDaemon`, `AppProcessInfo` (Task 5) — consistent.
