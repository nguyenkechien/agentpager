import type { Logger } from 'pino';

// Provider-neutral contracts between the agentpager core and an agent "brain" (Claude Code, Codex, …).
// Nothing in this file may reference a concrete provider or its SDK.

export type TurnInput =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; imageBase64: string; mediaType: 'image/jpeg'; imagePath: string; text: string };

export interface TurnRequest {
  chatId: number;
  cwd: string;
  resumeSessionId: string | null;
  model: string | null;
  effort: string | null;
  input: TurnInput;
}

export interface LimitSnapshot {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  windowKey: string | null;
  windowLabel: string;
  scope: 'global' | 'model';
  resetsAtMs: number | null;
  utilizationPercent: number | null;
  threshold: number | null;
}

export type TurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'activity' }
  | { type: 'tool'; name: string }
  | { type: 'result' }
  | { type: 'rate_limit'; snapshot: LimitSnapshot }
  | { type: 'api_retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { type: 'limit_error' };

export type TurnOutcome =
  | { kind: 'success'; text: string; costUsd: number | null }
  | { kind: 'error'; subtype: string; errors: string[]; costUsd: number | null };

export interface RunningTurn {
  interrupt(): Promise<void>;
  abort(): void;
  readonly done: Promise<TurnOutcome>;
}

export interface TurnSink {
  emit(event: TurnEvent): void;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export type AskUserResult = { answers: Record<string, string> } | { declined: string };

export interface ApprovalRequest {
  title: string;
  reason: string | null;
  summary: string;
}

export type ApprovalResult = { allow: true } | { allow: false; message: string };

/** Mid-turn interaction with the Telegram user, implemented by the core. */
export interface InteractionBroker {
  askUser(chatId: number, questions: Question[], signal: AbortSignal): Promise<AskUserResult>;
  requestApproval(chatId: number, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
}

export interface GuardRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

export interface GuardPolicy {
  match(command: string): GuardRule | null;
  onBlock(chatId: number, command: string, rule: GuardRule): void;
}

export interface FileSender {
  sendPhoto(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
  sendDocument(chatId: number, filePath: string, caption: string | undefined): Promise<void>;
}

export interface SessionInfo {
  sessionId: string;
  title: string;
  cwd: string | null;
  lastModified: number;
}

export interface SessionSource {
  list(options: { dir: string; limit: number; offset: number }): Promise<SessionInfo[]>;
  info(sessionId: string): Promise<SessionInfo | undefined>;
}

export interface UsageWindow {
  key: string;
  label: string;
  utilizationPercent: number | null;
  resetsAtMs: number | null;
}

export interface UsageReport {
  subscription: string | null;
  available: boolean;
  extraUsageEnabled: boolean;
  windows: UsageWindow[];
}

export interface ProviderCapabilities {
  /** 'kill': the provider cannot stop a turn gracefully; /stop aborts the process at once. */
  interrupt: 'native' | 'kill';
  approvals: boolean;
  askUser: boolean;
  sessionListing: boolean;
  commandGuard: boolean;
  fileSendTool: boolean;
  /** 'path': photos are saved and their path is passed as text. */
  imageInput: 'native' | 'path';
  usage: 'plan-limits' | 'tokens' | 'none';
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface Detection {
  /** null: the provider falls back to a bundled binary when it has one. */
  executable: string | null;
  version: string | null;
  /** Human-readable problems in Vietnamese. */
  problems: string[];
}

export interface ProviderSettings {
  executable: string | null;
}

export interface ProviderContext {
  guard: GuardPolicy;
  fileSender: FileSender;
  prompts: InteractionBroker;
  systemPrompt: string;
  logger: Logger;
}

/** Static description of a provider, available without constructing it (setup, config validation). */
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  models: readonly ModelOption[];
  efforts: readonly string[];
  detect(settings: ProviderSettings): Promise<Detection>;
}

export interface AgentProvider extends ProviderCatalogEntry {
  startTurn(request: TurnRequest, sink: TurnSink): RunningTurn;
  /** Present when capabilities.sessionListing is true. */
  sessions?: SessionSource;
  /** Present when capabilities.usage is not 'none'. */
  fetchUsage?(): Promise<UsageReport>;
}

export type ProviderFactory = (settings: ProviderSettings, context: ProviderContext) => AgentProvider;
