import { posix, resolve, win32 } from 'node:path';
import { importLegacy, parseDotEnv, type LegacyImport } from '../../core/config/importLegacy.js';
import {
  ConfigError,
  isValidBotToken,
  maskToken,
  normalizeUsername,
  type AgentpagerConfig,
  type AllowedUser,
} from '../../core/config/schema.js';
import type { ProviderCatalogEntry } from '../../providers/types.js';
import type { CliIo } from '../io.js';
import type { CliDeps, Command } from '../types.js';
import { autostartTarget } from './autostart.js';
import { daemonStatus, messageOf, restartDaemon, startDaemon } from './daemonControl.js';
import { describeUser } from './status.js';

const DEFAULT_IDLE_MINUTES = 60;

function isAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

async function importFrom(dir: string, io: CliIo, deps: CliDeps): Promise<LegacyImport> {
  const envText = await deps.readTextFile(resolve(dir, '.env'));
  const token = envText === null ? undefined : parseDotEnv(envText).TELEGRAM_BOT_TOKEN?.trim();
  const imported = await importLegacy(dir, {
    readFile: deps.readTextFile,
    exists: deps.exists,
    getChat: (userId) => (token ? deps.telegram.getChat(token, userId) : Promise.resolve(null)),
  });
  io.out(`📥 Nhập cấu hình cũ từ ${dir}`);
  for (const warning of imported.warnings) io.out(`  ⚠️ ${warning}`);
  return imported;
}

async function askToken(io: CliIo, deps: CliDeps, imported: string | null): Promise<{ token: string; botUsername: string }> {
  for (;;) {
    const question = imported ? `Bot token (Enter để dùng token đã nhập ${maskToken(imported)}): ` : 'Bot token từ @BotFather: ';
    const token = (await io.ask(question, { hidden: true })).trim() || imported || '';
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

async function askUsers(io: CliIo, imported: readonly AllowedUser[]): Promise<AllowedUser[]> {
  if (imported.length > 0) io.out(`Người dùng đã nhập: ${imported.map(describeUser).join(', ')}`);
  for (;;) {
    const answer = await io.ask(
      imported.length > 0
        ? 'Thêm username (phân tách bằng dấu phẩy, Enter để bỏ qua): '
        : 'Username Telegram được dùng bot (vd: @alice, @bob): ',
    );
    const parts = answer
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0 && imported.length === 0) {
      io.err('❌ Cần ít nhất 1 username.');
      continue;
    }
    try {
      const users = [...imported];
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

async function askProjectsRoot(io: CliIo, deps: CliDeps, imported: string | null): Promise<string> {
  const fallback = imported ?? (await defaultProjectsRoot(deps));
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

async function askExecutable(io: CliIo, deps: CliDeps, entry: ProviderCatalogEntry, imported: string | null): Promise<string | null> {
  let detection = await entry.detect({ executable: imported });
  if (imported !== null && detection.executable === null) {
    for (const problem of detection.problems) io.out(`  ⚠️ ${problem}`);
    detection = await entry.detect({ executable: null });
  }
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

async function askIdleMinutes(io: CliIo, fallback: number): Promise<number> {
  for (;;) {
    const answer = (await io.ask('Số phút không hoạt động trước khi kết thúc phiên: ', { defaultValue: String(fallback) })).trim();
    if (/^\d+$/.test(answer) && Number(answer) >= 1) return Number(answer);
    io.err('❌ Cần số nguyên ≥ 1.');
  }
}

function offered(io: CliIo, entry: ProviderCatalogEntry, kind: 'model' | 'effort', value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const known = kind === 'model' ? entry.models.some((model) => model.id === value) : entry.efforts.includes(value);
  if (known) return value;
  io.out(`  ⚠️ Bỏ qua ${kind} "${value}" (${entry.displayName} không có).`);
  return null;
}

async function copyState(io: CliIo, deps: CliDeps, from: string): Promise<void> {
  if ((await deps.exists(deps.paths.state)) && !(await io.confirm(`Đã có lịch sử phiên tại ${deps.paths.state}. Ghi đè bằng bản cũ?`, false))) {
    io.out('Giữ lịch sử phiên hiện tại.');
    return;
  }
  await deps.copyFile(from, deps.paths.state);
  io.out(`📋 Đã chép lịch sử phiên từ ${from}`);
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

export const setupCommand: Command = async (args, io, deps) => {
  const importDir = args.flags.import;
  if (importDir === true) {
    io.err('❌ Thiếu thư mục sau --import');
    return 1;
  }
  if ((await deps.configStore.exists()) && !(await io.confirm(`Đã có cấu hình tại ${deps.paths.config}. Ghi đè?`, false))) {
    io.out('Giữ nguyên cấu hình hiện tại.');
    return 0;
  }

  const imported = importDir === undefined ? null : await importFrom(importDir, io, deps);
  const previous = imported?.config;
  const { token, botUsername } = await askToken(io, deps, previous?.telegram?.botToken ?? null);
  const allowedUsers = await askUsers(io, previous?.allowedUsers ?? []);
  const projectsRoot = await askProjectsRoot(io, deps, previous?.projectsRoot ?? null);
  const entry = chooseProvider(io, deps);
  const executable = await askExecutable(io, deps, entry, previous?.agent?.executable ?? null);
  const idleTimeoutMinutes = await askIdleMinutes(io, previous?.idleTimeoutMinutes ?? DEFAULT_IDLE_MINUTES);

  const config: AgentpagerConfig = {
    version: 1,
    telegram: { botToken: token },
    allowedUsers,
    projectsRoot,
    idleTimeoutMinutes,
    logLevel: previous?.logLevel ?? 'info',
    agent: {
      provider: entry.id,
      executable,
      defaultModel: offered(io, entry, 'model', previous?.agent?.defaultModel),
      defaultEffort: offered(io, entry, 'effort', previous?.agent?.defaultEffort),
    },
  };
  await deps.configStore.write(config);
  io.out(`✅ Đã lưu cấu hình: ${deps.paths.config}`);

  if (imported?.stateFile) await copyState(io, deps, imported.stateFile);
  const pending = allowedUsers.filter((user) => user.userId === null && user.username !== null);
  if (pending.length > 0) {
    io.out(`👉 Nhắn một tin bất kỳ cho @${botUsername} từ ${pending.map((user) => `@${user.username ?? ''}`).join(', ')} để ghép tài khoản.`);
  }

  await offerAutostart(io, deps);
  return offerStart(io, deps);
};
