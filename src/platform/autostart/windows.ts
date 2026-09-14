import { z } from 'zod';
import { targetProblems } from './targetProblems.js';
import { TASK_NAME, type Autostart, type AutostartDeps, type AutostartStatus, type AutostartTarget } from './types.js';

const TASK_DESCRIPTION = 'agentpager: Telegram remote control for local coding agents';

/** Single-quoted PowerShell literal. PowerShell also treats typographic single quotes as delimiters. */
export function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/** Windows paths cannot contain `"`, so plain double quotes are enough for the task argument line. */
export function windowsTaskArguments(target: AutostartTarget): string {
  return `--headless "${target.nodePath}" "${target.cliPath}" daemon`;
}

export function parseWindowsTaskArguments(argumentsText: string, workingDir: string): AutostartTarget | null {
  const match = /^--headless\s+"([^"]+)"\s+"([^"]+)"\s+daemon\s*$/.exec(argumentsText.trim());
  if (!match?.[1] || !match[2]) return null;
  return { nodePath: match[1], cliPath: match[2], workingDir };
}

// Output uses ASCII markers and JSON: Windows PowerShell writes text in the console code page.
const PREAMBLE = ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'];

export function buildWindowsEnableScript(target: AutostartTarget): string {
  return [
    ...PREAMBLE,
    '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    // On Windows 11 the default terminal ignores hidden-window flags; conhost --headless creates no window at all.
    `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(windowsTaskArguments(target))} -WorkingDirectory ${psQuote(target.workingDir)}`,
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
      throw new Error(`Không ${action} được tự khởi động (PowerShell code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return outputLines(result.stdout);
  };

  return {
    async enable(target) {
      const lines = await runScript(buildWindowsEnableScript(target), 'bật');
      if (!lines.includes('REGISTERED')) throw new Error(`PowerShell không xác nhận đã tạo task: ${lines.join(' ')}`);
      return ['Đã bật tự khởi động agentpager khi đăng nhập Windows (Task Scheduler).'];
    },

    async disable() {
      const lines = await runScript(buildWindowsDisableScript(), 'tắt');
      if (lines.includes('NOT_REGISTERED')) return ['Tự khởi động chưa được bật.'];
      if (!lines.includes('REMOVED')) throw new Error(`PowerShell không xác nhận đã gỡ task: ${lines.join(' ')}`);
      return ['Đã tắt tự khởi động agentpager.'];
    },

    async status(): Promise<AutostartStatus> {
      const lines = await runScript(buildWindowsStatusScript(), 'đọc trạng thái');
      const parsed = statusSchema.safeParse(JSON.parse(lines.at(-1) ?? '{}'));
      if (!parsed.success) throw new Error(`Không đọc được trạng thái task: ${lines.join(' ')}`);
      if (!parsed.data.enabled) return { enabled: false, target: null, problems: [] };

      const execute = parsed.data.execute ?? '';
      const argumentsText = parsed.data.arguments ?? '';
      const target = /(^|\\)conhost\.exe$/i.test(execute)
        ? parseWindowsTaskArguments(argumentsText, parsed.data.workingDirectory ?? '')
        : null;
      if (!target) {
        return { enabled: true, target: null, problems: [`Task agentpager chạy lệnh không nhận ra: ${execute} ${argumentsText}`.trim()] };
      }
      return { enabled: true, target, problems: await targetProblems(target, deps.exists) };
    },
  };
}
