import { describe, expect, it } from 'vitest';
import { TRAY_IMAGE_FILES, trayImageFile, trayTheme } from '../../../src/main/shell/trayIcon.js';

describe('tray image files', () => {
  it('names one 16 px and one 32 px image per bar theme and status colour', () => {
    expect(trayImageFile('light', 'green', 1)).toBe('resources/tray/light-green.png');
    expect(trayImageFile('dark', 'red', 2)).toBe('resources/tray/dark-red@2x.png');
    expect(TRAY_IMAGE_FILES).toHaveLength(16);
    expect(new Set(TRAY_IMAGE_FILES.map((spec) => spec.file)).size).toBe(16);
    expect(TRAY_IMAGE_FILES.find((spec) => spec.file === 'resources/tray/dark-amber@2x.png')).toEqual({
      theme: 'dark',
      color: 'amber',
      scale: 2,
      size: 32,
      file: 'resources/tray/dark-amber@2x.png',
    });
  });
});

describe('trayTheme', () => {
  it('follows the taskbar on Windows and the appearance on macOS', () => {
    const lightApp = { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: true };
    expect(trayTheme('win32', lightApp)).toBe('dark');
    expect(trayTheme('darwin', lightApp)).toBe('light');
    const darkApp = { shouldUseDarkColors: true, shouldUseDarkColorsForSystemIntegratedUI: false };
    expect(trayTheme('win32', darkApp)).toBe('light');
    expect(trayTheme('darwin', darkApp)).toBe('dark');
  });
});
