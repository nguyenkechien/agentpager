import { getSessionInfo, listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { SessionInfo, SessionSource } from '../types.js';

export function toSessionInfo(info: SDKSessionInfo): SessionInfo {
  return {
    sessionId: info.sessionId,
    title: info.customTitle ?? info.summary,
    cwd: info.cwd ?? null,
    lastModified: info.lastModified,
  };
}

export const claudeSessionSource: SessionSource = {
  list: async (options) => (await listSessions(options)).map(toSessionInfo),
  info: async (sessionId) => {
    const info = await getSessionInfo(sessionId);
    return info ? toSessionInfo(info) : undefined;
  },
};
