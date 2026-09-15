import { posix } from 'node:path';
import { targetProblems } from './targetProblems.js';
import { LAUNCH_AGENT_LABEL, type Autostart, type AutostartDeps, type AutostartStatus, type AutostartTarget } from './types.js';

export function launchAgentPath(homedir: string): string {
  return posix.join(homedir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function buildLaunchAgentPlist(target: AutostartTarget, logPath: string): string {
  const string = (value: string): string => `<string>${xmlEscape(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(LAUNCH_AGENT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[target.command, ...target.args].map((value) => `    ${string(value)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${string(target.workingDir)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // The agentpager supervisor restarts the worker itself; launchd only starts it at login.
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  ${string(logPath)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(logPath)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function parseLaunchAgentPlist(text: string): AutostartTarget | null {
  const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  const workingDir = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text)?.[1];
  if (programArguments === undefined || workingDir === undefined) return null;
  const [command, ...args] = [...programArguments.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    xmlUnescape(match[1] ?? ''),
  );
  if (!command) return null;
  return { command, args, workingDir: xmlUnescape(workingDir), console: false };
}

export function createMacAutostart(deps: AutostartDeps): Autostart {
  const plistPath = launchAgentPath(deps.homedir);
  const domain = `gui/${deps.uid}`;
  const service = `${domain}/${LAUNCH_AGENT_LABEL}`;

  return {
    async enable(target) {
      const logPath = posix.join(deps.paths.logs, 'launchd.log');
      await deps.makeDir(posix.dirname(plistPath));
      await deps.makeDir(deps.paths.logs);
      await deps.writeFile(plistPath, buildLaunchAgentPlist(target, logPath));
      // Unload a previous definition first; a non-zero code here just means it was not loaded.
      await deps.runner.run('launchctl', ['bootout', service]);
      const loaded = await deps.runner.run('launchctl', ['bootstrap', domain, plistPath]);
      if (loaded.code !== 0) {
        throw new Error(`launchctl bootstrap failed (code ${loaded.code}): ${loaded.stderr.trim() || loaded.stdout.trim()}`);
      }
      return ['Enabled agentpager autostart at macOS login (LaunchAgent).'];
    },

    async disable() {
      if (!(await deps.exists(plistPath))) return ['Autostart is not enabled.'];
      await deps.runner.run('launchctl', ['bootout', service]);
      await deps.removeFile(plistPath);
      return ['Disabled agentpager autostart.'];
    },

    async status(): Promise<AutostartStatus> {
      const text = await deps.readFile(plistPath);
      if (text === null) return { enabled: false, target: null, problems: [] };
      const printed = await deps.runner.run('launchctl', ['print', service]);

      const target = parseLaunchAgentPlist(text);
      const problems: string[] = [];
      if (!target) problems.push(`File ${plistPath} is not in the agentpager format.`);
      else problems.push(...(await targetProblems(target, deps.exists)));
      if (printed.code !== 0) problems.push('The LaunchAgent file exists but is not loaded.');
      return { enabled: printed.code === 0, target, problems };
    },
  };
}
