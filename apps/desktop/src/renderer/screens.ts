export const SCREENS = [
  { id: 'status', label: 'Trạng thái' },
  { id: 'users', label: 'Người dùng' },
  { id: 'settings', label: 'Cài đặt' },
  { id: 'logs', label: 'Log' },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];
