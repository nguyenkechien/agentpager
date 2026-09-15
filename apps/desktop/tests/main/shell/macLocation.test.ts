import { describe, expect, it } from 'vitest';
import { macAppBundlePath, MOVE_BEFORE_AUTOSTART_MESSAGE, shouldOfferMove, unsafeAutostartLocation } from '../../../src/main/shell/macLocation.js';

const INSTALLED = '/Applications/agentpager.app/Contents/MacOS/agentpager';

describe('unsafeAutostartLocation', () => {
  it('refuses translocated and disk-image copies on macOS only', () => {
    expect(unsafeAutostartLocation('/private/var/folders/x/T/AppTranslocation/ABC/d/agentpager.app/Contents/MacOS/agentpager', 'darwin')).toBe(
      MOVE_BEFORE_AUTOSTART_MESSAGE,
    );
    expect(unsafeAutostartLocation('/Volumes/agentpager 0.1.0/agentpager.app/Contents/MacOS/agentpager', 'darwin')).toBe(MOVE_BEFORE_AUTOSTART_MESSAGE);
    expect(unsafeAutostartLocation(INSTALLED, 'darwin')).toBeNull();
    expect(unsafeAutostartLocation('/Users/alex/Apps/agentpager.app/Contents/MacOS/agentpager', 'darwin')).toBeNull();
    expect(unsafeAutostartLocation('/Volumes/x/agentpager.exe', 'win32')).toBeNull();
  });
});

describe('shouldOfferMove', () => {
  const base = { platform: 'darwin' as const, isPackaged: true, inApplicationsFolder: false, execPath: '/Users/alex/Downloads/agentpager.app/Contents/MacOS/agentpager', declinedPath: null };

  it('offers once per location for packaged macOS builds outside Applications', () => {
    expect(shouldOfferMove(base)).toBe(true);
    expect(shouldOfferMove({ ...base, declinedPath: base.execPath })).toBe(false);
    expect(shouldOfferMove({ ...base, declinedPath: '/elsewhere/agentpager.app/Contents/MacOS/agentpager' })).toBe(true);
    expect(shouldOfferMove({ ...base, inApplicationsFolder: true })).toBe(false);
    expect(shouldOfferMove({ ...base, isPackaged: false })).toBe(false);
    expect(shouldOfferMove({ ...base, platform: 'win32' })).toBe(false);
  });
});

describe('macAppBundlePath', () => {
  it('finds the .app bundle of the executable', () => {
    expect(macAppBundlePath(INSTALLED)).toBe('/Applications/agentpager.app');
    expect(macAppBundlePath('C:\\agentpager\\agentpager.exe')).toBeNull();
  });
});
