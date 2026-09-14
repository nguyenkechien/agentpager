import { describe, expect, it } from 'vitest';
import { createAutostart } from '../../src/platform/autostart/index.js';
import { buildLaunchAgentPlist, launchAgentPath, parseLaunchAgentPlist } from '../../src/platform/autostart/macos.js';
import type { AutostartDeps, AutostartTarget, CommandResult } from '../../src/platform/autostart/types.js';
import {
  buildWindowsDisableScript,
  buildWindowsEnableScript,
  buildWindowsStatusScript,
  parseWindowsTaskArguments,
  psQuote,
  windowsTaskArguments,
} from '../../src/platform/autostart/windows.js';
import { appPaths } from '../../src/platform/paths.js';

const winTarget: AutostartTarget = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliPath: "C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\node_modules\\agentpager\\dist\\cli\\main.js",
  workingDir: "C:\\Users\\O'Brien",
};

const macTarget: AutostartTarget = {
  nodePath: '/Users/alex/.nvm/versions/node/v24.1.0/bin/node',
  cliPath: '/Users/alex/Tools & <Apps>/agentpager/dist/cli/main.js',
  workingDir: '/Users/alex',
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

describe('Windows scripts', () => {
  it('quotes PowerShell literals, including typographic quotes', () => {
    expect(psQuote("C:\\it's here")).toBe("'C:\\it''s here'");
    expect(psQuote('D:\\Nguyễn’s')).toBe("'D:\\Nguyễn’’s'");
  });

  it('registers a headless logon task for the current user', () => {
    const script = buildWindowsEnableScript(winTarget);
    expect(script).toContain('$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(script).toContain(
      "New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\node_modules\\agentpager\\dist\\cli\\main.js\" daemon' -WorkingDirectory 'C:\\Users\\O''Brien'",
    );
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user');
    expect(script).toContain('-LogonType Interactive -RunLevel Limited');
    expect(script).toContain(
      '-ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
    );
    expect(script).toContain("Register-ScheduledTask -TaskName 'agentpager'");
  });

  it('builds disable and status scripts for the agentpager task', () => {
    expect(buildWindowsDisableScript()).toContain("Unregister-ScheduledTask -TaskName 'agentpager' -Confirm:$false");
    expect(buildWindowsStatusScript()).toContain("Get-ScheduledTask -TaskName 'agentpager'");
  });

  it('parses the task arguments it writes', () => {
    expect(parseWindowsTaskArguments(windowsTaskArguments(winTarget), winTarget.workingDir)).toEqual(winTarget);
    expect(parseWindowsTaskArguments('--headless powershell.exe -File other.ps1', 'C:\\')).toBeNull();
  });
});

describe('Windows autostart', () => {
  it('enables through PowerShell', async () => {
    const env = fakeEnv('win32', [{ code: 0, stdout: 'REGISTERED\r\n', stderr: '' }]);
    const messages = await createAutostart(env.deps).enable(winTarget);
    expect(env.calls[0]?.command).toBe('powershell.exe');
    expect(decodeScript(env.calls[0]?.args ?? [])).toBe(buildWindowsEnableScript(winTarget));
    expect(messages).toEqual(['Đã bật tự khởi động agentpager khi đăng nhập Windows (Task Scheduler).']);
  });

  it('fails with the PowerShell error output', async () => {
    const env = fakeEnv('win32', [{ code: 1, stdout: '', stderr: 'Access is denied.' }]);
    await expect(createAutostart(env.deps).enable(winTarget)).rejects.toThrow('Access is denied.');
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

  it('reads the registered target and warns about paths that no longer exist', async () => {
    const statusJson = JSON.stringify({
      enabled: true,
      execute: 'conhost.exe',
      arguments: windowsTaskArguments(winTarget),
      workingDirectory: winTarget.workingDir,
    });
    const env = fakeEnv(
      'win32',
      [
        { code: 0, stdout: `${statusJson}\r\n`, stderr: '' },
        { code: 0, stdout: `${statusJson}\r\n`, stderr: '' },
        { code: 0, stdout: '{"enabled":false}\r\n', stderr: '' },
        { code: 0, stdout: `${JSON.stringify({ enabled: true, execute: 'powershell.exe', arguments: '-File other.ps1' })}\r\n`, stderr: '' },
      ],
      [winTarget.nodePath, winTarget.cliPath],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({ enabled: true, target: winTarget, problems: [] });

    await env.deps.removeFile(winTarget.nodePath);
    const missing = await autostart.status();
    expect(missing.problems).toEqual([expect.stringMatching(/^Không còn tìm thấy Node tại C:\\Program Files\\nodejs\\node\.exe/)]);

    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });
    await expect(autostart.status()).resolves.toEqual({
      enabled: true,
      target: null,
      problems: ['Task agentpager chạy lệnh không nhận ra: powershell.exe -File other.ps1'],
    });
  });
});

describe('LaunchAgent plist', () => {
  it('escapes XML and runs the daemon at login without KeepAlive', () => {
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

  it('parses the plist it writes', () => {
    expect(parseLaunchAgentPlist(buildLaunchAgentPlist(macTarget, '/tmp/launchd.log'))).toEqual(macTarget);
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
    expect(plist).toBe('/Users/alex/Library/LaunchAgents/io.github.nguyenkechien.agentpager.plist');
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
      [macTarget.nodePath],
    );
    const autostart = createAutostart(env.deps);
    await expect(autostart.status()).resolves.toEqual({ enabled: false, target: null, problems: [] });

    await autostart.enable(macTarget);
    const loaded = await autostart.status();
    expect(loaded).toMatchObject({ enabled: true, target: macTarget });
    expect(loaded.problems).toEqual([expect.stringMatching(/^Không còn tìm thấy agentpager tại/)]);

    const unloaded = await autostart.status();
    expect(unloaded.enabled).toBe(false);
    expect(unloaded.problems).toContain('LaunchAgent có file nhưng chưa được nạp — chạy lại "agentpager autostart on".');
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
