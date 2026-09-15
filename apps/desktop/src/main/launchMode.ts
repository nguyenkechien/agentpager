export type MaintenanceTask = 'prepare-update' | 'uninstall-cleanup';

export type LaunchMode = { kind: 'daemon' } | { kind: 'maintenance'; task: MaintenanceTask } | { kind: 'gui'; hidden: boolean };

/**
 * `--daemon` wins over everything: that process must never open a window, a tray or take the single-instance lock.
 * The installer's maintenance flags come next; they never open a window either.
 */
export function parseLaunchMode(argv: readonly string[]): LaunchMode {
  if (argv.includes('--daemon')) return { kind: 'daemon' };
  if (argv.includes('--prepare-update')) return { kind: 'maintenance', task: 'prepare-update' };
  if (argv.includes('--uninstall-cleanup')) return { kind: 'maintenance', task: 'uninstall-cleanup' };
  return { kind: 'gui', hidden: argv.includes('--hidden') };
}
