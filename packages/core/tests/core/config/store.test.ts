import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, type AgentpagerConfig } from '../../../src/core/config/schema.js';
import { ConfigStore, MISSING_CONFIG_MESSAGE } from '../../../src/core/config/store.js';
import { createFakeProvider } from '../../support/fakeProvider.js';

const catalog = [createFakeProvider().provider];

function valid(): AgentpagerConfig {
  return {
    version: 1,
    telegram: { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwx' },
    allowedUsers: [{ username: 'example_user', userId: null, pairedAt: null }],
    projectsRoot: 'D:\\Projects',
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
  };
}

let file: string;
let store: ConfigStore;

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'pager-config-')), 'nested', 'config.json');
  store = new ConfigStore(file, { platform: process.platform, catalog });
});

describe('ConfigStore', () => {
  it('explains how to create a missing config', async () => {
    await expect(store.exists()).resolves.toBe(false);
    await expect(store.read()).rejects.toMatchObject({ issues: [MISSING_CONFIG_MESSAGE] });
  });

  it('writes atomically and reads the config back', async () => {
    await store.write(valid());
    await expect(store.exists()).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual(valid());
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(valid(), null, 2)}\n`);
  });

  it('refuses to write an invalid config and keeps the previous file', async () => {
    await store.write(valid());
    await expect(store.write({ ...valid(), allowedUsers: [] })).rejects.toBeInstanceOf(ConfigError);
    await expect(store.read()).resolves.toEqual(valid());
  });

  it('reports a corrupt file', async () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ nope');
    await expect(store.read()).rejects.toMatchObject({ issues: [expect.stringMatching(/không phải JSON hợp lệ/)] });
  });

  it('removes the temp file when the final rename fails', async () => {
    mkdirSync(file, { recursive: true });
    await expect(store.write(valid())).rejects.toThrow();
    expect(readdirSync(dirname(file))).toEqual(['config.json']);
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('restricts the file to its owner on POSIX', async () => {
    await store.write(valid());
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent updates so no change is lost', async () => {
    await store.write(valid());
    await Promise.all([
      store.update((current) => ({ ...current, idleTimeoutMinutes: 30 })),
      store.update((current) => ({ ...current, logLevel: 'debug' })),
    ]);
    await expect(store.read()).resolves.toMatchObject({ idleTimeoutMinutes: 30, logLevel: 'debug' });
  });

  it('re-reads the file before an update to keep external edits', async () => {
    const other = new ConfigStore(file, { platform: process.platform, catalog });
    await store.write(valid());
    await other.write({ ...valid(), projectsRoot: 'E:\\work' });
    const updated = await store.update((current) => ({ ...current, idleTimeoutMinutes: 5 }));
    expect(updated).toMatchObject({ projectsRoot: 'E:\\work', idleTimeoutMinutes: 5 });
  });

  it('keeps processing updates after one fails', async () => {
    await store.write(valid());
    const failing = store.update(() => {
      throw new Error('mutation failed');
    });
    const next = store.update((current) => ({ ...current, idleTimeoutMinutes: 15 }));
    await expect(failing).rejects.toThrow('mutation failed');
    await expect(next).resolves.toMatchObject({ idleTimeoutMinutes: 15 });
  });
});
