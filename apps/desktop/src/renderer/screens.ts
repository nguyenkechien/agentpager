export const SCREENS = [
  { id: 'status', label: 'Status' },
  { id: 'users', label: 'Users' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Log' },
] as const;

export type ScreenId = (typeof SCREENS)[number]['id'];
