export type LaunchMode = { kind: 'daemon' } | { kind: 'gui'; hidden: boolean };

/** `--daemon` wins over everything: that process must never open a window, a tray or take the single-instance lock. */
export function parseLaunchMode(argv: readonly string[]): LaunchMode {
  if (argv.includes('--daemon')) return { kind: 'daemon' };
  return { kind: 'gui', hidden: argv.includes('--hidden') };
}
