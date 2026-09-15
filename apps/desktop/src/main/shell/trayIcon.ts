import type { TrayColor } from './trayModel.js';

/** The theme of the bar the icon sits on: a light taskbar/menu bar needs a dark glyph. */
export type TrayTheme = 'light' | 'dark';
export type TrayScale = 1 | 2;

export const TRAY_THEMES: readonly TrayTheme[] = ['light', 'dark'];
export const TRAY_COLORS: readonly TrayColor[] = ['green', 'amber', 'grey', 'red'];
/** Logical size in points; the @2x file is twice as large. */
export const TRAY_SIZE = 16;

export const TRAY_GLYPH_COLORS: Record<TrayTheme, string> = { light: '#1f2937', dark: '#ffffff' };
export const TRAY_DOT_COLORS: Record<TrayColor, string> = { green: '#22c55e', amber: '#f59e0b', grey: '#94a3b8', red: '#ef4444' };

/** Path of a generated tray image, relative to the app folder (`app.getAppPath()`, also inside app.asar). */
export function trayImageFile(theme: TrayTheme, color: TrayColor, scale: TrayScale): string {
  return `resources/tray/${theme}-${color}${scale === 2 ? '@2x' : ''}.png`;
}

export interface TrayImageSpec {
  theme: TrayTheme;
  color: TrayColor;
  scale: TrayScale;
  /** Pixel size of the file. */
  size: number;
  file: string;
}

export const TRAY_IMAGE_FILES: readonly TrayImageSpec[] = TRAY_THEMES.flatMap((theme) =>
  TRAY_COLORS.flatMap((color) =>
    ([1, 2] as const).map((scale) => ({ theme, color, scale, size: TRAY_SIZE * scale, file: trayImageFile(theme, color, scale) })),
  ),
);

export interface ThemeFlags {
  shouldUseDarkColors: boolean;
  shouldUseDarkColorsForSystemIntegratedUI: boolean;
}

/** Windows draws the tray on the taskbar (system theme); macOS on the menu bar, which follows the appearance. */
export function trayTheme(platform: NodeJS.Platform, flags: ThemeFlags): TrayTheme {
  const dark = platform === 'win32' ? flags.shouldUseDarkColorsForSystemIntegratedUI : flags.shouldUseDarkColors;
  return dark ? 'dark' : 'light';
}
