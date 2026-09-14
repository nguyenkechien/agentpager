import { normalizeUsername, type AllowedUser } from '../../core/config/schema.js';
import type { CliDeps, Command } from '../types.js';
import { notifyUsersChanged } from './daemonControl.js';

const USAGE = 'Cách dùng: agentpager users list | add <@username> | remove <@username|id> | unpair <@username>';

function describe(user: AllowedUser): string {
  if (user.username === null) return `id ${user.userId === null ? '?' : String(user.userId)} · đã ghép (chưa rõ username)`;
  if (user.userId === null) return `@${user.username} · chờ ghép`;
  return `@${user.username} · đã ghép (id ${user.userId}${user.pairedAt ? `, ${user.pairedAt}` : ''})`;
}

async function listUsers(deps: CliDeps): Promise<AllowedUser[]> {
  return (await deps.configStore.read()).allowedUsers;
}

export const usersCommand: Command = async (args, io, deps) => {
  const [action, target] = args.positionals;
  if (action === 'list') {
    const users = await listUsers(deps);
    if (users.length === 0) io.out('Chưa có người dùng.');
    for (const user of users) io.out(describe(user));
    return 0;
  }
  if ((action !== 'add' && action !== 'remove' && action !== 'unpair') || target === undefined) {
    io.err(USAGE);
    return 1;
  }

  if (action === 'remove' && /^\d+$/.test(target)) {
    const userId = Number(target);
    if (!(await listUsers(deps)).some((user) => user.userId === userId)) {
      io.err(`❌ Không có user id ${userId} trong danh sách.`);
      return 1;
    }
    await deps.configStore.update((config) => ({
      ...config,
      allowedUsers: config.allowedUsers.filter((user) => user.userId !== userId),
    }));
    io.out(`✅ Đã xoá user id ${userId}.`);
    await notifyUsersChanged(io, deps);
    return 0;
  }

  const username = normalizeUsername(target);
  const existing = (await listUsers(deps)).find((user) => user.username === username);

  switch (action) {
    case 'add':
      if (existing) {
        io.err(`❌ @${username} đã có trong danh sách.`);
        return 1;
      }
      await deps.configStore.update((config) => ({
        ...config,
        allowedUsers: [...config.allowedUsers, { username, userId: null, pairedAt: null }],
      }));
      io.out(`✅ Đã thêm @${username} — nhắn bot một tin từ tài khoản này để ghép.`);
      break;
    case 'remove':
      if (!existing) {
        io.err(`❌ Không có @${username} trong danh sách.`);
        return 1;
      }
      await deps.configStore.update((config) => ({
        ...config,
        allowedUsers: config.allowedUsers.filter((user) => user.username !== username),
      }));
      io.out(`✅ Đã xoá @${username}.`);
      break;
    case 'unpair':
      if (!existing) {
        io.err(`❌ Không có @${username} trong danh sách.`);
        return 1;
      }
      if (existing.userId === null) {
        io.out(`@${username} chưa được ghép.`);
        return 0;
      }
      await deps.configStore.update((config) => ({
        ...config,
        allowedUsers: config.allowedUsers.map((user) =>
          user.username === username ? { ...user, userId: null, pairedAt: null } : user,
        ),
      }));
      io.out(`✅ Đã bỏ ghép @${username} — tin nhắn tiếp theo từ @${username} sẽ ghép lại.`);
      break;
  }
  await notifyUsersChanged(io, deps);
  return 0;
};
