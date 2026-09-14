import { useCallback, useEffect, useState } from 'react';
import type { ApiError, ApiResult, ConfigView, DaemonView } from '../shared/api.js';
import { api, errorOf, unwrap } from './api.js';

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
