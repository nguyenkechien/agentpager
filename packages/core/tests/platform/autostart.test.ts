import { describe, expect, it } from 'vitest';
import { createAutostart } from '../../src/platform/autostart/index.js';
import { buildLaunchAgentPlist, launchAgentPath, parseLaunchAgentPlist } from '../../src/platform/autostart/macos.js';
import { targetProblems } from '../../src/platform/autostart/targetProblems.js';
import type { AutostartDeps, AutostartTarget, CommandResult } from '../../src/platform/autostart/types.js';
import {
  buildWindowsDisableScript,
  buildWindowsEnableScript,
  buildWindowsStatusScript,
  parseWindowsTaskAction,
  psQuote,
  splitWindowsArguments,
  windowsTaskAction,
} from '../../src/platform/autostart/windows.js';
import { appPaths } from '../../src/platform/paths.js';

const cliTarget: AutostartTarget = {
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ["C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\@chiennguyen\\agentpager\\dist\\cli\\main.js", 'daemon'],
  workingDir: "C:\\Users\\O'Brien",
  console: true,
};

const appTarget: AutostartTarget = {
  command: 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe',
  args: ['--daemon'],
  workingDir: 'C:\\Users\\alex',
  console: false,
};

const macTarget: AutostartTarget = {
  command: '/Users/alex/.nvm/versions/node/v24.1.0/bin/node',
  args: ['/Users/alex/Tools & <Apps>/agentpager/dist/cli/main.js', 'daemon'],
  workingDir: '/Users/alex',
  console: true,
};

interface FakeEnv {
  deps: AutostartDeps;
  calls: { command: string; args: string[] }[];
  files: Map<string, string>;
  dirs: string[];
}

function fakeEnv(platform: NodeJS.Platform, results: CommandResult[], existing: string[] = []): FakeEnv {
  const calls: { command: string; args: string[] }[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const present = new Set(existing);
  const homedir = platform === 'win32' ? "C:\\Users\\O'Brien" : '/Users/alex';
  const deps: AutostartDeps = {
    platform,
    homedir,
    uid: 501,
    paths: appPaths({ platform, env: {}, homedir, username: 'alex' }),
    runner: {
      run: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(results.shift() ?? { code: 0, stdout: '', stderr: '' });
      },
    },
    writeFile: (path, text) => {
      files.set(path, text);
      present.add(path);
      return Promise.resolve();
    },
    removeFile: (path) => {
      files.delete(path);
      present.delete(path);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(present.has(path)),
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
    makeDir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
  };
  return { deps, calls, files, dirs };
}

function decodeScript(args: string[]): string {
  expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  return Buffer.from(args[5] ?? '', 'base64').toString('utf16le');
}

describe('Windows task action', () => {
  it('wraps console programs in conhost --headless and runs GUI programs directly', () => {
    expect(windowsTaskAction(cliTarget)).toEqual({
      execute: 'conhost.exe',
      argument:
        "--headless \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\@chiennguyen\\agentpager\\dist\\cli\\main.js\" \"daemon\"",
    });
    expect(windowsTaskAction(appTarget)).toEqual({
      execute: 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe',
      argument: '"--daemon"',
    });
  });

  it('splits quoted and bare arguments', () => {
    expect(splitWindowsArguments('--headless "C:\\a b\\node.exe" "C:\\cli.js" daemon')).toEqual([
      '--headless',
      'C:\\a b\\node.exe',
      'C:\\cli.js',
      'daemon',
    ]);
    expect(splitWindowsArguments('')).toEqual([]);
  });

  it('parses both action shapes back into targets', () => {
    const cli = windowsTaskAction(cliTarget);
    expect(parseWindowsTaskAction(cli.execute, cli.argument, cliTarget.workingDir)).toEqual(cliTarget);
    const app = windowsTaskAction(appTarget);
    expect(parseWindowsTaskAction(app.execute, app.argument, appTarget.workingDir)).toEqual(appTarget);
    // Tasks registered by agentpager 0.1.x left the last argument unquoted.
    expect(parseWindowsTaskAction('conhost.exe', '--headless "C:\\node.exe" "C:\\cli.js" daemon', 'C:\\')).toEqual({
      command: 'C:\\node.exe',
      args: ['C:\\cli.js', 'daemon'],
      workingDir: 'C:\\',
      console: true,
    });
    expect(parseWindowsTaskAction('conhost.exe', 'powershell.exe -File other.ps1', 'C:\\')).toBeNull();
    expect(parseWindowsTaskAction('', '', 'C:\\')).toBeNull();
  });
});

describe('Windows scripts', () => {
  it('quotes PowerShell literals, including typographic quotes', () => {
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'");
    expect(psQuote('D:\\Nguyễn’s')).toBe("'D:\\Nguyễn’’s'");
  });

  it('registers a headless logon task for a console target', () => {
    const script = buildWindowsEnableScript(cliTarget);
    expect(script).toContain('$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).toContain(
      `New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(windowsTaskAction(cliTarget).argument)} -WorkingDirectory 'C:\\Users\\O''Brien'`,
    );
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user');
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain(
      '-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    );
    expect(script).toContain("Register-ScheduledTask -TaskName 'agentpager'");
  });

  it('registers the app executable itself for a GUI target', () => {
    const script = buildWindowsEnableScript(appTarget);
    expect(script).toContain(
      "New-ScheduledTaskAction -Execute 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe' -Argument '\"--daemon\"' -WorkingDirectory 'C:\\Users\\alex'",
    );
    expect(script).not.toContain('conhost');
  });

  it('omits -Argument when a target has no arguments', () => {
    expect(buildWindowsEnableScript({ ...appTarget, args: [] })).toContain(
      "New-ScheduledTaskAction -Execute 'C:\\Users\\alex\\AppData\\Local\\Programs\\agentpager\\agentpager.exe' -WorkingDirectory 'C:\\Users\\alex'",
    );
  });

  it('builds disable and status scripts for the agentpager task', () => {
    expect(buildWindowsDisableScript()).toContain("Unregister-ScheduledTask -TaskName 'agentpager' -Confirm:$false");
    expect(buildWindowsStatusScript()).toContain("Get-ScheduledTask -TaskName 'agentpager'");
  });
});

describe('Windows autostart', () => {
  it('enables through PowerShell', async () => {
    const env = fakeEnv('win32', [{ code: 0, stdout: 'REGISTERED\r\n', stderr: '' }]);
    const messages = await createAutostart(env.deps).enable(appTarget);
    expect(env.calls[0]?.command).toBe('powershell.exe');
    expect(decodeScript(env.calls[0]?.args ?? [])).toBe(buildWindowsEnableScript(appTarget));
    expect(messages).toEqual(['Đã bật tự khởi động agentpager khi đăng nhập Windows (Task Scheduler).']);
  });

  it('fails with the PowerShell error output', async () => {
    const env = fakeEnv('win32', [{ code: 1, stdout: '', stderr: 'Access is denied.' }]);
    await expect(createAutostart(env.deps).enable(cliTarget)).rejects.toThrow('Access is denied.');
  });

  it('disables the task or explains it was not enabled', async () => {
    const env = fakeEnv('win32', [
      { code: 0, stdout: 'REMOVED\r\n', stderr: '' },
      { code: 0, stdout: 'NOT_REGISTERED\r\n', stderr: '' },
    ]);
    const autostart = createAutostart(env.deps);
    await expect(autostart.disable()).resolves.toEqual(['Đã tắt tự khởi động agentpager.']);
    await expect(autostart.disable()).resolves.toEqual(['Tự khởi động chưa được bật.']);
  });

  it('reads either target shape and warns about paths that no longer exist', async () => {
    const statusJson = (target: AutostartTarget): string => {
      const action = windowsTaskAction(target);
      return `${JSON.stringify({ enabled: true, execute: action.execute, arguments: action.argument, workingDirectory: target.workingDir })}\r\n`;
    };
    const env = fakeEnv(
      'win32',
      [
        { code: 0, stdout: statusJson(cliTarget), stderr: '' },
        { code: 0, stdout: statusJson(appTarget), stderr: '' },
        { code: 0, stdout: '{"enabled":false}\r\n', stderr: '' },
        { code: 0, stdout: `${JSON.stringify({ enabled: true, execute: 'conhost.exe', arguments: 'powershell.exe -File other.ps1' })}\r\n`, stderr: '' },
      ],
      [cliTarget.command],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: cliTarget,
      problems: [`Không còn tìm thấy ${cliTarget.args[0] ?? ''}`],
    });
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: appTarget,
      problems: [`Không còn tìm thấy ${appTarget.command}`],
    });
    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: null,
      problems: ['Task agentpager chạy lệnh không nhận ra: conhost.exe powershell.exe -File other.ps1'],
    });
  });
});

describe('targetProblems', () => {
  it('checks the command and absolute path arguments only', async () => {
    const exists = (path: string): Promise<boolean> => Promise.resolve(path === appTarget.command);
    await expect(targetProblems(appTarget, exists)).resolves.toEqual([]);
    await expect(targetProblems({ ...cliTarget }, exists)).resolves.toEqual([
      `Không còn tìm thấy ${cliTarget.command}`,
      `Không còn tìm thấy ${cliTarget.args[0] ?? ''}`,
    ]);
  });
});

describe('LaunchAgent plist', () => {
  it('escapes XML and runs the target at login without KeepAlive', () => {
    expect(buildLaunchAgentPlist(macTarget, '/Users/alex/Library/Application Support/agentpager/logs/launchd.log')).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>io.github.nguyenkechien.agentpager</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/Users/alex/.nvm/versions/node/v24.1.0/bin/node</string>',
        '    <string>/Users/alex/Tools &amp; &lt;Apps&gt;/agentpager/dist/cli/main.js</string>',
        '    <string>daemon</string>',
        '  </array>',
        '  <key>WorkingDirectory</key>',
        '  <string>/Users/alex</string>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <false/>',
        '  <key>StandardOutPath</key>',
        '  <string>/Users/alex/Library/Application Support/agentpager/logs/launchd.log</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>/Users/alex/Library/Application Support/agentpager/logs/launchd.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });

  it('parses the plist it writes (console is Windows-only)', () => {
    expect(parseLaunchAgentPlist(buildLaunchAgentPlist(macTarget, '/tmp/launchd.log'))).toEqual({ ...macTarget, console: false });
    const appOnMac: AutostartTarget = {
      command: '/Applications/agentpager.app/Contents/MacOS/agentpager',
      args: ['--daemon'],
      workingDir: '/Users/alex',
      console: false,
    };
    expect(parseLaunchAgentPlist(buildLaunchAgentPlist(appOnMac, '/tmp/launchd.log'))).toEqual(appOnMac);
    expect(parseLaunchAgentPlist('<plist><dict></dict></plist>')).toBeNull();
  });
});

describe('macOS autostart', () => {
  const plist = launchAgentPath('/Users/alex');
  const logs = '/Users/alex/Library/Application Support/agentpager/logs';

  it('writes the plist, reloads it with launchctl and ignores a missing previous load', async () => {
    const env = fakeEnv('darwin', [
      { code: 113, stdout: '', stderr: 'Could not find service' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    await expect(createAutostart(env.deps).enable(macTarget)).resolves.toEqual([
      'Đã bật tự khởi động agentpager khi đăng nhập macOS (LaunchAgent).',
    ]);
    expect(env.dirs).toEqual(['/Users/alex/Library/LaunchAgents', logs]);
    expect(env.files.get(plist)).toBe(buildLaunchAgentPlist(macTarget, `${logs}/launchd.log`));
    expect(env.calls).toEqual([
      { command: 'launchctl', args: ['bootout', 'gui/501/io.github.nguyenkechien.agentpager'] },
      { command: 'launchctl', args: ['bootstrap', 'gui/501', plist] },
    ]);
  });

  it('fails when launchctl cannot load the agent', async () => {
    const env = fakeEnv('darwin', [
      { code: 0, stdout: '', stderr: '' },
      { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' },
    ]);
    await expect(createAutostart(env.deps).enable(macTarget)).rejects.toThrow('Bootstrap failed: 5: Input/output error');
  });

  it('disables by unloading and deleting the plist', async () => {
    const env = fakeEnv('darwin', []);
    const autostart = createAutostart(env.deps);
    await expect(autostart.disable()).resolves.toEqual(['Tự khởi động chưa được bật.']);
    await autostart.enable(macTarget);
    await expect(autostart.disable()).resolves.toEqual(['Đã tắt tự khởi động agentpager.']);
    expect(env.files.has(plist)).toBe(false);
    expect(env.calls.at(-1)).toEqual({ command: 'launchctl', args: ['bootout', 'gui/501/io.github.nguyenkechien.agentpager'] });
  });

  it('reports loaded state, target and problems', async () => {
    const env = fakeEnv(
      'darwin',
      [
        { code: 113, stdout: '', stderr: 'Could not find service' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: 'state = running', stderr: '' },
        { code: 113, stdout: '', stderr: 'not found' },
      ],
      [macTarget.command],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });
    await autostart.enable(macTarget);
    const loaded = await autostart.status();
    expect(loaded).toMatchObject({ enabled: true, target: { ...macTarget, console: false } });
    expect(loaded.problems).toEqual([`Không còn tìm thấy ${macTarget.args[0] ?? ''}`]);
    const unloaded = await autostart.status();
    expect(unloaded.enabled).toBe(false);
    expect(unloaded.problems).toContain('LaunchAgent có file nhưng chưa được nạp.');
  });
});

describe('unsupported platforms', () => {
  it('rejects every operation', async () => {
    const autostart = createAutostart(fakeEnv('linux', []).deps);
    await expect(autostart.enable(macTarget)).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
    await expect(autostart.disable()).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
    await expect(autostart.status()).rejects.toThrow('Autostart chỉ hỗ trợ Windows và macOS');
  });
});
