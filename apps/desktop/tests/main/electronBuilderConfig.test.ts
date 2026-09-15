import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const appRoot = join(import.meta.dirname, '..', '..');

const configSchema = z.object({
  extraMetadata: z.object({ name: z.string() }),
  files: z.array(z.string()),
  asarUnpack: z.array(z.string()),
  win: z.object({ target: z.array(z.object({ target: z.string(), arch: z.array(z.string()) })), icon: z.string() }),
  nsis: z.record(z.string(), z.unknown()),
  mac: z.object({ target: z.array(z.object({ target: z.string() })), identity: z.string(), hardenedRuntime: z.boolean(), icon: z.string() }),
  dmg: z.object({ artifactName: z.string() }),
  publish: z.record(z.string(), z.unknown()),
});

const config = configSchema.parse(load(readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8')));
const installerScript = readFileSync(join(appRoot, 'build', 'installer.nsh'), 'utf8');

describe('electron-builder.yml', () => {
  it('never lets the uninstaller delete the bot data folder shared with agentpager cli', () => {
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it('names the packaged app agentpager, which is also the per-user install folder', () => {
    expect(config.extraMetadata.name).toBe('agentpager');
  });

  it('builds a per-user one-click NSIS installer with the installer hooks', () => {
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(config.win.icon).toBe('build/icon.ico');
    expect(config.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      include: 'build/installer.nsh',
      artifactName: 'agentpager-Setup-${version}.exe',
    });
  });

  it('builds ad-hoc signed disk images per architecture', () => {
    expect(config.mac.target).toEqual([{ target: 'dmg' }]);
    expect(config.mac.identity).toBe('-');
    expect(config.mac.hardenedRuntime).toBe(false);
    expect(config.mac.icon).toBe('build/icon-mac.png');
    expect(config.dmg.artifactName).toBe('agentpager-${version}-${arch}.dmg');
  });

  it('publishes to a draft GitHub release of this repository', () => {
    expect(config.publish).toEqual({ provider: 'github', owner: 'nguyenkechien', repo: 'agentpager', releaseType: 'draft' });
  });

  it('packs the tray images and keeps the unpacked runtime files', () => {
    expect(config.files).toContain('resources/tray/**');
    expect(config.asarUnpack).toContain('node_modules/@chiennguyen/agentpager/**');
    expect(config.asarUnpack).toContain('node_modules/@anthropic-ai/claude-agent-sdk-*/**');
  });
});

describe('build/installer.nsh', () => {
  it('stops the bot before replacing files and keeps the default process check', () => {
    expect(installerScript).toContain('!include "getProcessInfo.nsh"');
    expect(installerScript).toContain('--prepare-update');
    expect(installerScript).toContain('!insertmacro _CHECK_APP_RUNNING');
  });

  it('cleans up machine-wide settings only on a real uninstall, never the shared bot data', () => {
    expect(installerScript).toMatch(/\$\{ifNot\} \$\{isUpdated\}[\s\S]*--uninstall-cleanup/);
    expect(installerScript).toContain('RMDir /r "$APPDATA\\agentpager-desktop"');
    expect(installerScript).not.toMatch(/RMDir \/r "\$APPDATA\\agentpager"/);
  });
});
