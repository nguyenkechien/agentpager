import type {
  AgentProvider,
  ProviderCapabilities,
  RunningTurn,
  SessionInfo,
  TurnEvent,
  TurnOutcome,
  TurnRequest,
  TurnSink,
  UsageReport,
} from '../../src/providers/types.js';

export class FakeTurn implements RunningTurn {
  interrupted = false;
  aborted = false;
  interruptResult: Promise<void> = Promise.resolve();
  readonly done: Promise<TurnOutcome>;
  private resolveDone: (outcome: TurnOutcome) => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  constructor(
    readonly request: TurnRequest,
    private readonly sink: TurnSink,
  ) {
    this.done = new Promise<TurnOutcome>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  emit(event: TurnEvent): void {
    this.sink.emit(event);
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    return this.interruptResult;
  }

  abort(): void {
    this.aborted = true;
  }

  succeed(text = 'ok', costUsd: number | null = 0.1): void {
    this.resolveDone({ kind: 'success', text, costUsd });
  }

  fail(subtype: string, errors: string[]): void {
    this.resolveDone({ kind: 'error', subtype, errors, costUsd: 0.2 });
  }

  crash(error: Error): void {
    this.rejectDone(error);
  }
}

export const FULL_CAPABILITIES: ProviderCapabilities = {
  interrupt: 'native',
  approvals: true,
  askUser: true,
  sessionListing: true,
  commandGuard: true,
  fileSendTool: true,
  imageInput: 'native',
  usage: 'plan-limits',
};

export interface FakeProviderHandle {
  provider: AgentProvider;
  turns: FakeTurn[];
  sessions: SessionInfo[];
  usage: { report: UsageReport | Error };
  /** Number of startTurn calls that should throw before succeeding. */
  startFailures: { count: number };
  turn(index: number): FakeTurn;
}

export function createFakeProvider(overrides: Partial<ProviderCapabilities> = {}): FakeProviderHandle {
  const capabilities: ProviderCapabilities = { ...FULL_CAPABILITIES, ...overrides };
  const turns: FakeTurn[] = [];
  const sessions: SessionInfo[] = [];
  const usage: { report: UsageReport | Error } = {
    report: { subscription: 'test', available: true, extraUsageEnabled: false, windows: [] },
  };
  const startFailures = { count: 0 };

  const provider: AgentProvider = {
    id: 'fake',
    displayName: 'Fake Agent',
    capabilities,
    models: [
      { id: 'fast', label: 'Fast' },
      { id: 'smart', label: 'Smart' },
    ],
    efforts: ['low', 'high'],
    detect: () => Promise.resolve({ executable: null, version: null, problems: [] }),
    startTurn: (request, sink) => {
      if (startFailures.count > 0) {
        startFailures.count -= 1;
        throw new Error('spawn failed');
      }
      const turn = new FakeTurn(request, sink);
      turns.push(turn);
      return turn;
    },
    ...(capabilities.sessionListing
      ? {
          sessions: {
            list: ({ dir, limit, offset }) =>
              Promise.resolve(sessions.filter((session) => session.cwd === dir).slice(offset, offset + limit)),
            info: (sessionId) => Promise.resolve(sessions.find((session) => session.sessionId === sessionId)),
          },
        }
      : {}),
    ...(capabilities.usage !== 'none'
      ? {
          fetchUsage: () => (usage.report instanceof Error ? Promise.reject(usage.report) : Promise.resolve(usage.report)),
        }
      : {}),
  };

  return {
    provider,
    turns,
    sessions,
    usage,
    startFailures,
    turn: (index) => {
      const turn = turns[index];
      if (!turn) throw new Error(`no turn ${index}`);
      return turn;
    },
  };
}
