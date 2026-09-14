import type { BadgeState } from './api.js';

export const BADGE_LABELS: Record<BadgeState, string> = {
  running: 'Đang chạy',
  starting: 'Đang khởi động',
  restarting: 'Đang khởi động lại',
  stopped: 'Đã dừng',
  error: 'Lỗi',
  unresponsive: 'Bot không phản hồi',
  disconnected: 'Mất kết nối',
};
