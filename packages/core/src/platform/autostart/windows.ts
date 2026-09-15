import { z } from 'zod';
import { targetProblems } from './targetProblems.js';
import { TASK_NAME, type Autostart, type AutostartDeps, type AutostartStatus, type AutostartTarget } from './types.js';

const TASK_DESCRIPTION = 'agentpager: Telegram remote control for local coding agents';

/** Single-quoted PowerShell literal. PowerShell also treats typographic single quotes as delimiters. */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/** Task Scheduler arguments: every value in double quotes (Windows paths and our flags never contain `"`). */
function quoteArgument(value: string): string {
  return `"${value}"`;
}

/**
 * The scheduled task action for a target. Console programs (node) run inside `conhost.exe --headless`, because
 * the Windows 11 default terminal ignores hidden-window flags; GUI programs (the desktop app) are the action itself.
 */
export function windowsTaskAction(target: AutostartTarget): { execute: string; argument: string } {
  const args = target.args.map(quoteArgument);
  if (target.console) {
    return { execute: 'conhost.exe', argument: ['--headless', quoteArgument(target.command), ...args].join(' ') };
  }
  return { execute: target.command, argument: args.join(' ') };
}

export function splitWindowsArguments(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
}

export function parseWindowsTaskAction(execute: string, argumentsText: string, workingDir: string): AutostartTarget | null {
  const tokens = splitWindowsArguments(argumentsText);
  if (/(^|\\)conhost\.exe$/i.test(execute)) {
    const [flag, command, ...args] = tokens;
    if (flag !== '--headless' || !command) return null;
    return { command, args, workingDir, console: true };
  }
  if (execute.trim() === '') return null;
  return { command: execute, args: tokens, workingDir, console: false };
}

// Output uses ASCII markers and JSON: Windows PowerShell writes text in the console code page.
const PREAMBLE = ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'];

export function buildWindowsEnableScript(target: AutostartTarget): string {
  const action = windowsTaskAction(target);
  const argument = action.argument === '' ? '' : ` -Argument ${psQuote(action.argument)}`;
  return [
    ...PREAMBLE,
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute ${psQuote(action.execute)}${argument} -WorkingDirectory ${psQuote(target.workingDir)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${psQuote(TASK_DESCRIPTION)} -Force | Out-Null`,
    "Write-Output 'REGISTERED'",
  ].join('\n');
}

export function buildWindowsDisableScript(): string {
  const task = psQuote(TASK_NAME);
  return [
    ...PREAMBLE,
    `$task = Get-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { Write-Output 'NOT_REGISTERED'; exit 0 }",
    `if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName ${task} }`,
    `Unregister-ScheduledTask -TaskName ${task} -Confirm:$false`,
    "Write-Output 'REMOVED'",
  ].join('\n');
}

export function buildWindowsStatusScript(): string {
  return [
    ...PREAMBLE,
    `$task = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { Write-Output '{\"enabled\":false}'; exit 0 }",
    '$action = $task.Actions | Select-Object -First 1',
    '[pscustomobject]@{ enabled = $true; execute = $action.Execute; arguments = $action.Arguments; workingDirectory = $action.WorkingDirectory } | ConvertTo-Json -Compress',
  ].join('\n');
}

/** -EncodedCommand avoids Windows command-line quoting rules mangling paths inside the script. */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

const statusSchema = z.object({
  enabled: z.boolean(),
  execute: z.string().nullable().optional(),
  arguments: z.string().nullable().optional(),
  workingDirectory: z.string().nullable().optional(),
});

function outputLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function createWindowsAutostart(deps: AutostartDeps): Autostart {
  const runScript = async (script: string, action: string): Promise<string[]> => {
    const result = await deps.runner.run('powershell.exe', powershellArgs(script));
    if (result.code !== 0) {
      throw new Error(`Could not ${action} autostart (PowerShell code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return outputLines(result.stdout);
  };

  return {
    async enable(target) {
      const lines = await runScript(buildWindowsEnableScript(target), 'enable');
      if (!lines.includes('REGISTERED')) throw new Error(`PowerShell did not confirm that the task was created: ${lines.join(' ')}`);
      return ['Enabled agentpager autostart at Windows login (Task Scheduler).'];
    },

    async disable() {
      const lines = await runScript(buildWindowsDisableScript(), 'disable');
      if (lines.includes('NOT_REGISTERED')) return ['Autostart is not enabled.'];
      if (!lines.includes('REMOVED')) throw new Error(`PowerShell did not confirm that the task was removed: ${lines.join(' ')}`);
      return ['Disabled agentpager autostart.'];
    },

    async status(): Promise<AutostartStatus> {
      const lines = await runScript(buildWindowsStatusScript(), 'read the status of');
      const parsed = statusSchema.safeParse(JSON.parse(lines.at(-1) ?? '{}'));
      if (!parsed.success) throw new Error(`Could not read the task status: ${lines.join(' ')}`);
      if (!parsed.data.enabled) return { enabled: false, target: null, problems: [] };

      const execute = parsed.data.execute ?? '';
      const argumentsText = parsed.data.arguments ?? '';
      const target = parseWindowsTaskAction(execute, argumentsText, parsed.data.workingDirectory ?? '');
      if (!target) {
        return { enabled: true, target: null, problems: [`The agentpager task runs an unrecognised command: ${execute} ${argumentsText}`.trim()] };
      }
      return { enabled: true, target, problems: await targetProblems(target, deps.exists) };
    },
  };
}
