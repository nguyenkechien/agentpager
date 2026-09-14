import { posix, win32 } from 'node:path';
import {
  ConfigError,
  isValidBotToken,
  normalizeUsername,
  type AgentpagerConfig,
  type AllowedUser,
} from '../../core/config/schema.js';
import type { ProviderCatalogEntry } from '../../providers/types.js';
import type { CliIo } from '../io.js';
import type { CliDeps, Command } from '../types.js';
import { autostartTarget } from './autostart.js';
import { daemonStatus, messageOf, restartDaemon, startDaemon } from './daemonControl.js';

const DEFAULT_IDLE_MINUTES = 60;

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

async function askToken(io: CliIo, deps: CliDeps): Promise<{ token: string; botUsername: string }> {
  for (;;) {
    const token = (await io.ask('Bot token từ @BotFather: ', { hidden: true })).trim();
    if (!isValidBotToken(token)) {
      io.err('❌ Token không đúng định dạng <số>:<chuỗi> của BotFather.');
      continue;
    }
    try {
      const me = await deps.telegram.getMe(token);
      io.out(`✅ Bot @${me.username}`);
      return { token, botUsername: me.username };
    } catch (error) {
      io.err(`❌ Token không dùng được: ${messageOf(error)}`);
    }
  }
}

async function askUsers(io: CliIo): Promise<AllowedUser[]> {
  for (;;) {
    const parts = (await io.ask('Username Telegram được dùng bot (vd: @alice, @bob): '))
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      io.err('❌ Cần ít nhất 1 username.');
      continue;
    }
    try {
      const users: AllowedUser[] = [];
      for (const part of parts) {
        const username = normalizeUsername(part);
        if (!users.some((user) => user.username === username)) users.push({ username, userId: null, pairedAt: null });
      }
      return users;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      io.err(`❌ ${error.issues.join('; ')}`);
    }
  }
}

async function defaultProjectsRoot(deps: CliDeps): Promise<string> {
  const { platform, homedir } = deps.platform;
  const candidate = platform === 'win32' ? 'D:\\Projects' : posix.join(homedir, 'Projects');
  return (await deps.exists(candidate)) ? candidate : homedir;
}

async function askProjectsRoot(io: CliIo, deps: CliDeps): Promise<string> {
  const fallback = await defaultProjectsRoot(deps);
  for (;;) {
    const answer = (await io.ask('Thư mục chứa các project: ', { defaultValue: fallback })).trim() || fallback;
    if (!isAbsolutePath(answer)) {
      io.err(`❌ Cần đường dẫn tuyệt đối: ${answer}`);
      continue;
    }
    if (!(await deps.exists(answer))) {
      io.err(`❌ Không tìm thấy thư mục: ${answer}`);
      continue;
    }
    return answer;
  }
}

function chooseProvider(io: CliIo, deps: CliDeps): ProviderCatalogEntry {
  const entry = deps.catalog[0];
  if (!entry) throw new Error('No agent providers are available');
  io.out(`Agent: ${entry.displayName}`);
  return entry;
}

async function askExecutable(io: CliIo, entry: ProviderCatalogEntry, deps: CliDeps): Promise<string | null> {
  const detection = await entry.detect({ executable: null });
  if (detection.executable !== null) {
    io.out(`🔎 ${entry.displayName} CLI: ${detection.executable}${detection.version ? ` (${detection.version})` : ''}`);
  }
  for (const problem of detection.problems) io.out(`  ⚠️ ${problem}`);

  for (;;) {
    const answer = (
      await io.ask(detection.executable !== null ? 'Đường dẫn CLI (Enter để dùng đường dẫn trên): ' : 'Đường dẫn CLI (Enter để dùng bản đi kèm SDK): ')
    ).trim();
    if (answer === '') return detection.executable;
    if (!isAbsolutePath(answer)) {
      io.err(`❌ Cần đường dẫn tuyệt đối: ${answer}`);
      continue;
    }
    if (!(await deps.exists(answer))) {
      io.err(`❌ Không tìm thấy file: ${answer}`);
      continue;
    }
    return answer;
  }
}

async function askIdleMinutes(io: CliIo): Promise<number> {
  for (;;) {
    const answer = (await io.ask('Số phút không hoạt động trước khi kết thúc phiên: ', { defaultValue: String(DEFAULT_IDLE_MINUTES) })).trim();
    if (/^\d+$/.test(answer) && Number(answer) >= 1) return Number(answer);
    io.err('❌ Cần số nguyên ≥ 1.');
  }
}

async function offerAutostart(io: CliIo, deps: CliDeps): Promise<void> {
  if (deps.platform.platform !== 'win32' && deps.platform.platform !== 'darwin') return;
  if (!(await io.confirm('Bật tự khởi động khi đăng nhập?', true))) return;
  try {
    for (const message of await deps.autostart.enable(autostartTarget(deps))) io.out(message);
  } catch (error) {
    // Setup is already saved; report the autostart failure and let the user retry with "autostart on".
    io.err(`❌ ${messageOf(error)} — thử lại bằng "agentpager autostart on".`);
  }
}

async function offerStart(io: CliIo, deps: CliDeps): Promise<number> {
  const running = await daemonStatus(deps);
  if (running) {
    if (!(await io.confirm('agentpager đang chạy. Khởi động lại để áp dụng cấu hình mới?', true))) return 0;
    return restartDaemon(io, deps, running);
  }
  if (!(await io.confirm('Chạy agentpager ngay?', true))) return 0;
  return startDaemon(io, deps);
}

export const setupCommand: Command = async (_args, io, deps) => {
  if ((await deps.configStore.exists()) && !(await io.confirm(`Đã có cấu hình tại ${deps.paths.config}. Ghi đè?`, false))) {
    io.out('Giữ nguyên cấu hình hiện tại.');
    return 0;
  }

  const { token, botUsername } = await askToken(io, deps);
  const allowedUsers = await askUsers(io);
  const projectsRoot = await askProjectsRoot(io, deps);
  const entry = chooseProvider(io, deps);
  const executable = await askExecutable(io, entry, deps);
  const idleTimeoutMinutes = await askIdleMinutes(io);

  const config: AgentpagerConfig = {
    version: 1,
    telegram: { botToken: token },
    allowedUsers,
    projectsRoot,
    idleTimeoutMinutes,
    logLevel: 'info',
    agent: { provider: entry.id, executable, defaultModel: null, defaultEffort: null },
  };
  await deps.configStore.write(config);
  io.out(`✅ Đã lưu cấu hình: ${deps.paths.config}`);
  io.out(`👉 Nhắn một tin bất kỳ cho @${botUsername} từ ${allowedUsers.map((user) => `@${user.username}`).join(', ')} để ghép tài khoản.`);

  await offerAutostart(io, deps);
  return offerStart(io, deps);
};
