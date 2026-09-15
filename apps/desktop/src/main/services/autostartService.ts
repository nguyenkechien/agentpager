import type { Autostart, AutostartTarget } from '@chiennguyen/agentpager/platform';
import type { AutostartView } from '../../shared/api.js';
import { homeOverrideNote } from '../../shared/labels.js';
import { unsafeAutostartLocation } from '../shell/macLocation.js';
import { ApiFailure } from './results.js';

export interface AutostartServiceDeps {
  autostart: Autostart;
  /** This app as the daemon: see `appAutostartTarget`. */
  target: AutostartTarget;
  platform: NodeJS.Platform;
  /** AGENTPAGER_HOME: the logon task is one per user and cannot carry it, so changes are refused. */
  homeOverride?: string | null;
}

/** The desktop executable is a GUI program: no console wrapper on Windows. */
export function appAutostartTarget(command: { command: string; args: string[] }, homedir: string): AutostartTarget {
  return { command: command.command, args: command.args, workingDir: homedir, console: false };
}

export class AutostartService {
  constructor(private readonly deps: AutostartServiceDeps) {}

  async get(): Promise<AutostartView> {
    const status = await this.deps.autostart.status();
    const { target } = status;
    return {
      enabled: status.enabled,
      command: target === null ? null : [target.command, ...target.args],
      ownedByThisApp: target !== null && this.isThisApp(target),
      problems: status.problems,
    };
  }

  /**
   * A successful enable/disable already tells the new state; reading it back would start another PowerShell
   * (about a second on Windows) for nothing.
   */
  async set(enabled: boolean): Promise<AutostartView> {
    const home = this.deps.homeOverride ?? null;
    if (home !== null) throw new ApiFailure({ code: 'invalid_input', message: homeOverrideNote(home) });
    if (!enabled) {
      await this.deps.autostart.disable();
      return { enabled: false, command: null, ownedByThisApp: false, problems: [] };
    }
    const { target } = this.deps;
    const unsafe = unsafeAutostartLocation(target.command, this.deps.platform);
    if (unsafe !== null) throw new ApiFailure({ code: 'invalid_input', message: unsafe });
    await this.deps.autostart.enable(target);
    return { enabled: true, command: [target.command, ...target.args], ownedByThisApp: true, problems: [] };
  }

  private isThisApp(target: AutostartTarget): boolean {
    // Windows paths are case-insensitive; macOS volumes usually are too, but a false "not this app" only offers a switch.
    const same = (a: string, b: string): boolean => (this.deps.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const expected = this.deps.target;
    return (
      same(target.command, expected.command) &&
      target.args.length === expected.args.length &&
      target.args.every((arg, index) => same(arg, expected.args[index] ?? ''))
    );
  }
}
