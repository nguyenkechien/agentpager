export const MOVE_BEFORE_AUTOSTART_MESSAGE = 'Hãy chuyển agentpager vào Applications trước khi bật tự khởi động.';

/**
 * macOS runs a quarantined app from a random read-only copy (App Translocation) or straight from the disk image;
 * a LaunchAgent pointing there breaks after the next reboot.
 */
export function unsafeAutostartLocation(command: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null;
  return command.includes('/AppTranslocation/') || command.startsWith('/Volumes/') ? MOVE_BEFORE_AUTOSTART_MESSAGE : null;
}

export interface MoveOfferInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  inApplicationsFolder: boolean;
  execPath: string;
  /** The executable path for which the user chose "Để sau". */
  declinedPath: string | null;
}

export function shouldOfferMove(input: MoveOfferInput): boolean {
  return input.platform === 'darwin' && input.isPackaged && !input.inApplicationsFolder && input.declinedPath !== input.execPath;
}

/** `/Applications/agentpager.app/Contents/MacOS/agentpager` → `/Applications/agentpager.app`. */
export function macAppBundlePath(execPath: string): string | null {
  const marker = '.app/Contents/MacOS/';
  const index = execPath.lastIndexOf(marker);
  return index === -1 ? null : execPath.slice(0, index + '.app'.length);
}
