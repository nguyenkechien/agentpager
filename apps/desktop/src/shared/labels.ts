import type { BadgeState } from './api.js';

export function homeOverrideNote(home: string): string {
  return `Đang dùng thư mục dữ liệu riêng (AGENTPAGER_HOME = ${home}). Tự khởi động và icon khay khi đăng nhập là thiết lập chung của máy nên không bật/tắt được ở chế độ này.`;
}

export const BADGE_LABELS: Record<BadgeState, string> = {
  running: 'Đang chạy',
  starting: 'Đang khởi động',
  restarting: 'Đang khởi động lại',
  stopped: 'Đã dừng',
  error: 'Lỗi',
  unresponsive: 'Bot không phản hồi',
  disconnected: 'Mất kết nối',
};
