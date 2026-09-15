import { useCallback, useEffect, useState } from 'react';
import type { ApiError, ApiResult, AppInfo, ConfigView, DaemonView, UpdateView } from '../shared/api.js';
import { api, errorOf, unwrap } from './api.js';

/** The updater state: read once, then kept current by the main process's pushes. */
export function useUpdate(): { view: UpdateView | null; setView: (view: UpdateView) => void } {
  const [view, setView] = useState<UpdateView | null>(null);
  useEffect(() => {
    let active = true;
    const stop = api().onUpdate((next) => {
      setView(next);
    });
    void api()
      .update.get()
      .then((result) => {
        // Without an answer nothing about updates is shown; the next push fills it in.
        if (active && result.ok) setView(result.data);
      });
    return () => {
      active = false;
      stop();
    };
  }, []);
  return { view, setView };
}

/** The daemon view: read once, then kept current by the main process's status pushes. */
export function useDaemon(): { view: DaemonView | null; error: ApiError | null; setView: (view: DaemonView) => void } {
  const [view, setView] = useState<DaemonView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let active = true;
    const stop = api().onStatus((next) => {
      setView(next);
    });
    unwrap(api().daemon.status()).then(
      (next) => {
        if (active) setView(next);
      },
      (reason: unknown) => {
        if (active) setError(errorOf(reason));
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, []);
  return { view, error, setView };
}

/** config.json as the main process sees it, reloaded whenever the file changes (pairing, CLI edits, saves). */
export function useConfig(): { view: ConfigView | null; error: ApiError | null; reload: () => Promise<ConfigView | null> } {
  const [view, setView] = useState<ConfigView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const reload = useCallback(async (): Promise<ConfigView | null> => {
    try {
      const next = await unwrap(api().config.load());
      setView(next);
      setError(null);
      return next;
    } catch (reason) {
      setError(errorOf(reason));
      return null;
    }
  }, []);
  useEffect(() => {
    void reload();
    return api().onConfigChanged(() => {
      void reload();
    });
  }, [reload]);
  return { view, error, reload };
}

/** Facts about this app process; null until the first answer. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let active = true;
    void api()
      .app.info()
      .then((result) => {
        // Without an answer the switches stay visible; the main process still refuses machine-wide changes in that mode.
        if (active) setInfo(result.ok ? result.data : { homeOverride: null, platform: '', version: '' });
      });
    return () => {
      active = false;
    };
  }, []);
  return info;
}

export interface Action {
  /** Name of the call in progress, e.g. "start". */
  pending: string | null;
  error: ApiError | null;
  run: <T>(name: string, call: () => Promise<ApiResult<T>>) => Promise<T | null>;
  clearError: () => void;
}

/** One call at a time with its progress and failure, for buttons. */
export function useAction(): Action {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async <T,>(name: string, call: () => Promise<ApiResult<T>>): Promise<T | null> => {
    setPending(name);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return null;
      }
      return result.data;
    } catch (reason) {
      setError(errorOf(reason));
      return null;
    } finally {
      setPending(null);
    }
  }, []);
  const clearError = useCallback(() => {
    setError(null);
  }, []);
  return { pending, error, run, clearError };
}
