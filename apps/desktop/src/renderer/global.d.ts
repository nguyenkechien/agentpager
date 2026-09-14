import type { AgentpagerApi } from '../shared/api.js';

declare global {
  interface Window {
    /** Exposed by the preload script. */
    agentpager: AgentpagerApi;
  }
}

export {};
