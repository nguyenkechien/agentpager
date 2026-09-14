import type { AgentpagerApi, ApiError, ApiResult } from '../shared/api.js';

export function api(): AgentpagerApi {
  return window.agentpager;
}

export class ApiCallError extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiCallError';
  }
}

export async function unwrap<T>(call: Promise<ApiResult<T>>): Promise<T> {
  const result = await call;
  if (!result.ok) throw new ApiCallError(result.error);
  return result.data;
}

export function errorOf(error: unknown): ApiError {
  if (error instanceof ApiCallError) return error.error;
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) };
}
