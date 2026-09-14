import type { AgentProvider, ModelOption, SessionSource } from '../../providers/types.js';
import type { Button } from '../prompts/broker.js';
import { listHistory, resolveResumeTarget } from '../sessions/history.js';
import type { SessionManager, SubmitResult } from '../sessions/manager.js';
import type { StateStore } from '../sessions/store.js';
import { formatClock, formatDuration, historyLine, projectName } from './format.js';
import type { ProjectSnapshot } from './projects.js';

export const BUSY_TEXT = 'Agent đang chạy, /stop trước.';
export const STALE_BUTTON_TEXT = 'Nút này không còn hiệu lực';
export const NO_SESSION_LISTING_TEXT = '📂 Provider này không hỗ trợ liệt kê mọi session.';
export const NO_USAGE_TEXT = '📊 Provider này không cung cấp thông tin usage.';
const BUTTON_TITLE_LENGTH = 40;
const EFFORT_ROW_SIZE = 3;

export interface View {
  text: string;
  keyboard: Button[][];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function submitReply(result: SubmitResult, nowMs: number): string | null {
  switch (result.kind) {
    case 'started':
      return null;
    case 'queued':
      return `📥 Đã xếp hàng (vị trí ${result.position})`;
    case 'queue_full':
      return '⚠️ Hàng đợi đầy (10). Dùng /stop hoặc đợi.';
    case 'limit_blocked':
      return `⛔ Vẫn đang hết limit ${result.label} · reset lúc ${formatClock(result.resetsAtMs, nowMs)} (còn ${formatDuration(result.resetsAtMs - nowMs)}). Tin nhắn chưa được gửi cho agent.`;
  }
}

export function helpText(cwd: string, idleMinutes: number, provider: Pick<AgentProvider, 'displayName' | 'capabilities'>): string {
  const { capabilities } = provider;
  return [
    `🤖 agentpager — điều khiển ${provider.displayName} trên máy từ xa.`,
    'Nhắn tin bình thường để làm việc với agent. Gửi ảnh hoặc file để agent xem.',
    '',
    `📁 Project hiện tại: ${cwd}`,
    '',
    'Lệnh:',
    '/new — mở phiên mới',
    capabilities.sessionListing ? '/history — session cũ (/history all: mọi session của project)' : '/history — session cũ',
    '/resume — vào lại session (/resume <id>)',
    '/project — chọn project',
    '/stop — dừng lượt đang chạy',
    '/status — trạng thái',
    '/model — đổi model / effort',
    ...(capabilities.usage !== 'none' ? ['/usage — mức dùng limit 5 giờ / 7 ngày'] : []),
    '',
    `Phiên tự kết thúc sau ${idleMinutes} phút không hoạt động.`,
  ].join('\n');
}

export async function historyView(
  mode: 'bot' | 'all',
  chatId: number,
  page: number,
  deps: { store: StateStore; source: SessionSource | undefined; now: () => number },
): Promise<View> {
  if (mode === 'all' && !deps.source) return { text: NO_SESSION_LISTING_TEXT, keyboard: [] };

  const result = await listHistory(mode, chatId, page, deps);
  const cwd = deps.store.getChat(chatId).cwd;
  const toggle: Button[] = [];
  if (deps.source) {
    toggle.push(
      mode === 'bot'
        ? { text: '📂 Mọi session của project', data: 'h:a:0' }
        : { text: '🤖 Session tạo từ bot', data: 'h:b:0' },
    );
  }
  const toggleRows: Button[][] = toggle.length > 0 ? [toggle] : [];
  const modeKey = mode === 'bot' ? 'b' : 'a';

  const header =
    mode === 'bot' ? `🗂 Session tạo từ bot (trang ${page + 1})` : `🗂 Mọi session trong ${projectName(cwd)} (trang ${page + 1})`;
  if (result.entries.length === 0) {
    const empty = mode === 'bot' ? 'Chưa có session nào tạo từ bot.' : 'Không có session nào trong project này.';
    const keyboard: Button[][] =
      page > 0 ? [[{ text: '⬅️', data: `h:${modeKey}:${page - 1}` }], ...toggleRows] : toggleRows;
    return { text: `${header}\n\n${empty}`, keyboard };
  }

  const offset = page * 10;
  const now = deps.now();
  const lines = result.entries.map((entry, index) => `${offset + index + 1}. ${historyLine(entry, now, mode)}`);
  const keyboard: Button[][] = result.entries.map((entry, index) => [
    { text: `▶️ ${offset + index + 1}. ${truncate(entry.title, BUTTON_TITLE_LENGTH)}`, data: `r:${entry.sessionId}` },
  ]);

  const navigation: Button[] = [];
  if (page > 0) navigation.push({ text: '⬅️', data: `h:${modeKey}:${page - 1}` });
  if (result.hasMore) navigation.push({ text: '➡️', data: `h:${modeKey}:${page + 1}` });
  if (navigation.length > 0) keyboard.push(navigation);
  keyboard.push(...toggleRows);

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

export function modelView(
  models: readonly ModelOption[],
  efforts: readonly string[],
  model: string | null,
  effort: string | null,
): View {
  const mark = (selected: boolean, label: string): string => `${selected ? '✅ ' : ''}${label}`;
  const selectedModel = models.find((option) => option.id === model) ?? null;
  const selectedEffort = effort !== null && efforts.includes(effort) ? effort : null;

  const modelRow: Button[] = [
    ...models.map((option) => ({ text: mark(selectedModel?.id === option.id, option.label), data: `m:${option.id}` })),
    { text: mark(selectedModel === null, 'mặc định'), data: 'm:default' },
  ];
  const effortButtons: Button[] = [
    ...efforts.map((level) => ({ text: mark(selectedEffort === level, level), data: `e:${level}` })),
    { text: mark(selectedEffort === null, 'mặc định'), data: 'e:default' },
  ];
  const keyboard: Button[][] = [modelRow];
  for (let i = 0; i < effortButtons.length; i += EFFORT_ROW_SIZE) keyboard.push(effortButtons.slice(i, i + EFFORT_ROW_SIZE));

  return {
    text: `🤖 Model: ${selectedModel?.label ?? 'mặc định'} · Effort: ${selectedEffort ?? 'mặc định'}\nÁp dụng từ tin nhắn tiếp theo.`,
    keyboard,
  };
}

export async function resumeReply(
  arg: string,
  chatId: number,
  deps: {
    store: StateStore;
    source: SessionSource | undefined;
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
