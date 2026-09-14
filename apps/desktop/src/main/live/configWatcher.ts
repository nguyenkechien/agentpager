export const CONFIG_DEBOUNCE_MS = 300;

export interface ConfigWatcherDeps {
  dir: string;
  fileName: string;
  /** `fs.watch` on the folder: the config is replaced by rename, which a watch on the file itself would lose. */
  watch: (dir: string, listener: (fileName: string | null) => void) => { close: () => void };
  onChange: () => void;
  debounceMs?: number;
}

/** One `onChange` per burst of events touching the config file (a save writes a temp file, then renames it). */
export function watchConfig(deps: ConfigWatcherDeps): { close: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const watcher = deps.watch(deps.dir, (fileName) => {
    // Some platforms do not report the name; treat that as a possible config change.
    if (fileName !== null && fileName !== deps.fileName) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      deps.onChange();
    }, deps.debounceMs ?? CONFIG_DEBOUNCE_MS);
  });
  return {
    close: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}
