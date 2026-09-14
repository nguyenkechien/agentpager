import type { Button } from '../claude/prompts.js';
import { EFFORTS, MODEL_ALIASES, type Effort, type ModelAlias } from '../config.js';
import { listHistory, resolveResumeTarget, type SessionSource } from '../sessions/history.js';
import type { SessionManager, SubmitResult } from '../sessions/manager.js';
import type { StateStore } from '../sessions/store.js';
import { historyLine, projectName } from './format.js';
import type { ProjectSnapshot } from './projects.js';

export const BUSY_TEXT = 'Claude đang chạy, /stop trước.';
export const STALE_BUTTON_TEXT = 'Nút này không còn hiệu lực';
const BUTTON_TITLE_LENGTH = 40;

export interface View {
  text: string;
  keyboard: Button[][];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function submitReply(result: SubmitResult): string | null {
  switch (result.kind) {
    case 'started':
      return null;
    case 'queued':
      return `📥 Đã xếp hàng (vị trí ${result.position})`;
    case 'queue_full':
      return '⚠️ Hàng đợi đầy (10). Dùng /stop hoặc đợi.';
  }
}

export function helpText(cwd: string, idleMinutes: number): string {
  return [
    '🤖 claude-pager — điều khiển Claude Code trên máy từ xa.',
    'Nhắn tin bình thường để làm việc với Claude. Gửi ảnh hoặc file để Claude xem.',
    '',
    `📁 Project hiện tại: ${cwd}`,
    '',
    'Lệnh:',
    '/new — mở phiên mới',
    '/history — session cũ (/history all: mọi session của project)',
    '/resume — vào lại session (/resume <id>)',
    '/project — chọn project',
    '/stop — dừng lượt đang chạy',
    '/status — trạng thái',
    '/model — đổi model / effort',
    '',
    `Phiên tự kết thúc sau ${idleMinutes} phút không hoạt động.`,
  ].join('\n');
}

export async function historyView(
  mode: 'bot' | 'all',
  chatId: number,
  page: number,
  deps: { store: StateStore; source: SessionSource; now: () => number },
): Promise<View> {
  const result = await listHistory(mode, chatId, page, deps);
  const cwd = deps.store.getChat(chatId).cwd;
  const toggle: Button[] = [
    mode === 'bot'
      ? { text: '📂 Mọi session của project', data: 'h:a:0' }
      : { text: '🤖 Session tạo từ bot', data: 'h:b:0' },
  ];

  const header =
    mode === 'bot' ? `🗂 Session tạo từ bot (trang ${page + 1})` : `🗂 Mọi session trong ${projectName(cwd)} (trang ${page + 1})`;
  if (result.entries.length === 0) {
    const empty = mode === 'bot' ? 'Chưa có session nào tạo từ bot.' : 'Không có session nào trong project này.';
    const keyboard: Button[][] = page > 0 ? [[{ text: '⬅️', data: `h:${mode[0] ?? 'b'}:${page - 1}` }], toggle] : [toggle];
    return { text: `${header}\n\n${empty}`, keyboard };
  }

  const offset = page * 10;
  const now = deps.now();
  const lines = result.entries.map((entry, index) => `${offset + index + 1}. ${historyLine(entry, now, mode)}`);
  const keyboard: Button[][] = result.entries.map((entry, index) => [
    { text: `▶️ ${offset + index + 1}. ${truncate(entry.title, BUTTON_TITLE_LENGTH)}`, data: `r:${entry.sessionId}` },
  ]);

  const modeKey = mode === 'bot' ? 'b' : 'a';
  const navigation: Button[] = [];
  if (page > 0) navigation.push({ text: '⬅️', data: `h:${modeKey}:${page - 1}` });
  if (result.hasMore) navigation.push({ text: '➡️', data: `h:${modeKey}:${page + 1}` });
  if (navigation.length > 0) keyboard.push(navigation);
  keyboard.push(toggle);

  return { text: `${header}\n\n${lines.join('\n')}`, keyboard };
}

export function projectView(cwd: string, snapshot: ProjectSnapshot): View {
  const buttons: Button[] = snapshot.dirs.map((dir, index) => {
    const label = index === 0 ? `${projectName(dir)} (gốc)` : projectName(dir);
    return { text: `${dir === cwd ? '✅ ' : ''}${label}`, data: `p:${snapshot.id}:${index}` };
  });
  const keyboard: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  return { text: `📁 Project hiện tại: ${cwd}\nChọn project:`, keyboard };
}

export function modelView(model: ModelAlias | null, effort: Effort | null): View {
  const mark = (selected: boolean, label: string): string => `${selected ? '✅ ' : ''}${label}`;
  const modelRow: Button[] = [
    ...MODEL_ALIASES.map((alias) => ({ text: mark(model === alias, alias), data: `m:${alias}` })),
    { text: mark(model === null, 'mặc định'), data: 'm:default' },
  ];
  const effortButtons: Button[] = [
    ...EFFORTS.map((level) => ({ text: mark(effort === level, level), data: `e:${level}` })),
    { text: mark(effort === null, 'mặc định'), data: 'e:default' },
  ];
  return {
    text: `🤖 Model: ${model ?? 'mặc định'} · Effort: ${effort ?? 'mặc định'}\nÁp dụng từ tin nhắn tiếp theo.`,
    keyboard: [modelRow, effortButtons.slice(0, 3), effortButtons.slice(3)],
  };
}

export async function resumeReply(
  arg: string,
  chatId: number,
  deps: {
    store: StateStore;
    source: SessionSource;
    manager: Pick<SessionManager, 'resume'>;
    pathExists: (path: string) => Promise<boolean>;
  },
): Promise<string> {
  const target = await resolveResumeTarget(arg, chatId, deps);
  switch (target.kind) {
    case 'too_short':
      return 'ID cần ít nhất 8 ký tự.';
    case 'not_found':
      return 'Không tìm thấy session này.';
    case 'ambiguous':
      return `Nhiều session khớp:\n${target.sessionIds.join('\n')}\nGõ thêm ký tự của ID.`;
    case 'cwd_missing':
      return `Thư mục của session không còn tồn tại: ${target.cwd}`;
    case 'ok':
      if (deps.manager.resume(chatId, target) === 'busy') return BUSY_TEXT;
      return `▶️ Đã vào lại: ${target.title} (${projectName(target.cwd)})`;
  }
}
