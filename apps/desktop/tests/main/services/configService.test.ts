import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '@chiennguyen/agentpager/config';
import type { UsersChangedResult } from '@chiennguyen/agentpager/control';
import { describe, expect, it } from 'vitest';
import {
  ConfigService,
  LAST_USER_MESSAGE,
  TOKEN_FORMAT_MESSAGE,
  UNPARSEABLE_CONFIG_MESSAGE,
  type ConfigServiceDeps,
  type TokenCheck,
} from '../../../src/main/services/configService.js';
import { toApiError } from '../../../src/main/services/results.js';
import type { ApiError, WizardInput } from '../../../src/shared/api.js';
import { fakeCatalog } from '../support/fakeCatalog.js';

const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwx';
const OTHER_TOKEN = '654321:ZYXwvuTSRqpoNMLkjiHGFedc';

interface Harness {
  service: ConfigService;
  dir: string;
  file: string;
  store: ConfigStore;
  tokenChecks: string[];
  tokenCheck: { result: TokenCheck };
  notify: { result: UsersChangedResult; calls: number };
}

function harness(overrides: Partial<ConfigServiceDeps> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ap-desktop-config-'));
  const file = join(dir, 'config.json');
  const store = new ConfigStore(file, { platform: process.platform, catalog: fakeCatalog });
  const tokenChecks: string[] = [];
  const tokenCheck: { result: TokenCheck } = { result: { kind: 'valid', username: 'test_bot' } };
  const notify: Harness['notify'] = { result: { kind: 'reloaded' }, calls: 0 };
  const service = new ConfigService({
    store,
    catalog: fakeCatalog,
    readText: (path) => (existsSync(path) ? readFile(path, 'utf8') : Promise.resolve(null)),
    pathExists: (path) => Promise.resolve(existsSync(path)),
    checkToken: (token) => {
      tokenChecks.push(token);
      return Promise.resolve(tokenCheck.result);
    },
    notifyUsersChanged: () => {
      notify.calls += 1;
      return Promise.resolve(notify.result);
    },
    platform: 'win32',
    homedir: 'C:\\Users\\alex',
    ...overrides,
  });
  return { service, dir, file, store, tokenChecks, tokenCheck, notify };
}

function wizardInput(dir: string, overrides: Partial<WizardInput> = {}): WizardInput {
  return {
    botToken: TOKEN,
    usernames: ['@Alice_One', 'bob_two', 'alice_one'],
    projectsRoot: dir,
    agent: { provider: 'fake', executable: null },
    idleTimeoutMinutes: 45,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return toApiError(error);
  }
  throw new Error('expected the call to fail');
}

async function configured(): Promise<Harness> {
  const h = harness();
  await h.service.runWizard(wizardInput(h.dir), false);
  return h;
}

function rawConfig(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    telegram: { botToken: TOKEN },
    allowedUsers: [{ username: 'alice_one', userId: 42, pairedAt: '2026-09-14T08:00:00.000Z' }],
    projectsRoot: dir,
    idleTimeoutMinutes: 60,
    logLevel: 'info',
    agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
    ...overrides,
  };
}

describe('ConfigService.load', () => {
  it('reports a missing config', async () => {
    const h = harness();
    await expect(h.service.load()).resolves.toEqual({ state: 'missing', path: h.file });
  });

  it('shows an invalid config with its issues per field and a best-effort draft', async () => {
    const h = harness();
    writeFileSync(h.file, JSON.stringify(rawConfig(h.dir, { idleTimeoutMinutes: 0 })));
    const view = await h.service.load();
    expect(view).toEqual({
      state: 'invalid',
      path: h.file,
      issues: ['idleTimeoutMinutes: must be ≥ 1'],
      fieldErrors: { idleTimeoutMinutes: ['must be ≥ 1'] },
      draft: {
        botTokenMasked: '123456…vwx',
        projectsRoot: h.dir,
        idleTimeoutMinutes: 0,
        logLevel: 'info',
        agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
      },
      users: [{ username: 'alice_one', paired: true, pairedAt: '2026-09-14T08:00:00.000Z' }],
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('marks an unparseable config invalid without a draft', async () => {
    const h = harness();
    writeFileSync(h.file, '{ torn');
    const view = await h.service.load();
    expect(view).toMatchObject({ state: 'invalid', draft: null, users: [] });
    if (view.state !== 'invalid') throw new Error('expected invalid');
    expect(view.fieldErrors.form?.[0]).toContain('is not valid JSON');
  });
});

describe('ConfigService.runWizard', () => {
  it('writes the config with normalised unique users and returns the token masked', async () => {
    const h = harness();
    const view = await h.service.runWizard(wizardInput(h.dir), false);
    expect(view).toEqual({
      state: 'valid',
      path: h.file,
      settings: {
        botTokenMasked: '123456…vwx',
        projectsRoot: h.dir,
        idleTimeoutMinutes: 45,
        logLevel: 'info',
        agent: { provider: 'fake', executable: null, defaultModel: null, defaultEffort: null },
      },
      users: [
        { username: 'alice_one', paired: false, pairedAt: null },
        { username: 'bob_two', paired: false, pairedAt: null },
      ],
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    await expect(h.store.read()).resolves.toMatchObject({ telegram: { botToken: TOKEN } });
  });

  it('refuses to overwrite an existing config unless asked', async () => {
    const h = await configured();
    await expect(failure(h.service.runWizard(wizardInput(h.dir), false))).resolves.toEqual({
      code: 'config_exists',
      message: `A config already exists at ${h.file}.`,
    });
    const view = await h.service.runWizard(wizardInput(h.dir, { botToken: OTHER_TOKEN }), true);
    expect(view).toMatchObject({ state: 'valid', settings: { botTokenMasked: '654321…edc' } });
  });

  it('reports every problem under its field', async () => {
    const h = harness();
    const error = await failure(
      h.service.runWizard(
        wizardInput(h.dir, {
          botToken: 'nope',
          usernames: ['@x', 'bob_two'],
          projectsRoot: join(h.dir, 'missing'),
          agent: { provider: 'fake', executable: join(h.dir, 'agent.exe') },
        }),
        false,
      ),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.fieldErrors).toEqual({
      botToken: [TOKEN_FORMAT_MESSAGE],
      projectsRoot: [`Folder not found: ${join(h.dir, 'missing')}`],
      'agent.executable': [`File not found: ${join(h.dir, 'agent.exe')}`],
      allowedUsers: ['Invalid username: "@x" (5–32 characters a-z, 0-9, _)'],
    });
    expect(existsSync(h.file)).toBe(false);

    const empty = await failure(h.service.runWizard(wizardInput(h.dir, { usernames: [] }), false));
    expect(empty.fieldErrors).toEqual({ allowedUsers: ['At least 1 username is required.'] });
  });
});

describe('ConfigService.save', () => {
  it('changes only the given fields', async () => {
    const h = await configured();
    const view = await h.service.save({ idleTimeoutMinutes: 90, agent: { defaultModel: 'smart' } });
    expect(view).toMatchObject({ state: 'valid', settings: { idleTimeoutMinutes: 90, agent: { provider: 'fake', defaultModel: 'smart' } } });
    const written = JSON.parse(readFileSync(h.file, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      telegram: { botToken: TOKEN },
      projectsRoot: h.dir,
      logLevel: 'info',
      allowedUsers: [{ username: 'alice_one' }, { username: 'bob_two' }],
    });
  });

  it('keeps a pairing the worker wrote after the settings were loaded', async () => {
    const h = await configured();
    await h.store.update((config) => ({
      ...config,
      allowedUsers: config.allowedUsers.map((user) => (user.username === 'alice_one' ? { ...user, userId: 7, pairedAt: '2026-09-14T09:00:00.000Z' } : user)),
    }));
    await h.service.save({ logLevel: 'debug' });
    await expect(h.store.read()).resolves.toMatchObject({ logLevel: 'debug', allowedUsers: [{ username: 'alice_one', userId: 7 }, { username: 'bob_two' }] });
  });

  it('replaces the token only when a new one is given', async () => {
    const h = await configured();
    await h.service.save({ botToken: OTHER_TOKEN });
    await expect(h.store.read()).resolves.toMatchObject({ telegram: { botToken: OTHER_TOKEN } });
    await expect(failure(h.service.save({ botToken: 'bad' }))).resolves.toEqual({
      code: 'invalid_input',
      message: TOKEN_FORMAT_MESSAGE,
      fieldErrors: { botToken: [TOKEN_FORMAT_MESSAGE] },
    });
  });

  it('reports the core validation per field', async () => {
    const h = await configured();
    await expect(failure(h.service.save({ projectsRoot: 'relative' }))).resolves.toMatchObject({
      code: 'invalid_config',
      fieldErrors: { projectsRoot: ['must be an absolute path: relative'] },
    });
    await expect(failure(h.service.save({ agent: { defaultModel: 'huge' } }))).resolves.toMatchObject({
      code: 'invalid_config',
      fieldErrors: { 'agent.defaultModel': ['"huge" is not available in Fake Agent (available: smart, fast)'] },
    });
  });

  it('repairs an invalid config when the patch fixes it', async () => {
    const h = harness();
    writeFileSync(h.file, JSON.stringify(rawConfig(h.dir, { idleTimeoutMinutes: 0 })));
    await expect(h.service.save({ idleTimeoutMinutes: 30 })).resolves.toMatchObject({ state: 'valid', settings: { idleTimeoutMinutes: 30 } });
  });

  it('cannot save over an unparseable file or without a config', async () => {
    const broken = harness();
    writeFileSync(broken.file, '{ torn');
    await expect(failure(broken.service.save({ idleTimeoutMinutes: 30 }))).resolves.toEqual({
      code: 'invalid_config',
      message: UNPARSEABLE_CONFIG_MESSAGE,
    });
    await expect(failure(harness().service.save({ idleTimeoutMinutes: 30 }))).resolves.toMatchObject({ code: 'missing_config' });
  });
});

describe('ConfigService.verifyToken', () => {
  it('checks the format before asking Telegram', async () => {
    const h = harness();
    await expect(failure(h.service.verifyToken('12:short'))).resolves.toEqual({ code: 'invalid_token', message: TOKEN_FORMAT_MESSAGE });
    expect(h.tokenChecks).toEqual([]);
  });

  it('distinguishes a valid token, a rejected token and a network failure', async () => {
    const h = harness();
    await expect(h.service.verifyToken(` ${TOKEN} `)).resolves.toEqual({ username: 'test_bot' });
    expect(h.tokenChecks).toEqual([TOKEN]);
    h.tokenCheck.result = { kind: 'invalid', message: '401 Unauthorized' };
    await expect(failure(h.service.verifyToken(TOKEN))).resolves.toEqual({ code: 'invalid_token', message: 'Invalid token: 401 Unauthorized' });
    h.tokenCheck.result = { kind: 'network', message: 'getaddrinfo ENOTFOUND api.telegram.org' };
    await expect(failure(h.service.verifyToken(TOKEN))).resolves.toEqual({
      code: 'network',
      message: 'Could not connect to Telegram: getaddrinfo ENOTFOUND api.telegram.org',
    });
  });
});

describe('ConfigService.defaults', () => {
  it('suggests the usual projects folder when it exists, else the home folder', async () => {
    const present = (paths: string[]) => (path: string) => Promise.resolve(paths.includes(path));
    await expect(harness({ pathExists: present(['D:\\Projects']) }).service.defaults()).resolves.toEqual({ projectsRoot: 'D:\\Projects' });
    await expect(harness({ pathExists: present([]) }).service.defaults()).resolves.toEqual({ projectsRoot: 'C:\\Users\\alex' });
    await expect(
      harness({ platform: 'darwin', homedir: '/Users/alex', pathExists: present(['/Users/alex/Projects']) }).service.defaults(),
    ).resolves.toEqual({ projectsRoot: '/Users/alex/Projects' });
  });
});

describe('ConfigService users', () => {
  it('adds a normalised username and tells the running bot', async () => {
    const h = await configured();
    const change = await h.service.addUser('@Carol_Three');
    expect(change).toEqual({
      users: [
        { username: 'alice_one', paired: false, pairedAt: null },
        { username: 'bob_two', paired: false, pairedAt: null },
        { username: 'carol_three', paired: false, pairedAt: null },
      ],
      reload: { kind: 'reloaded' },
    });
    expect(h.notify.calls).toBe(1);
  });

  it('rejects duplicates and invalid usernames', async () => {
    const h = await configured();
    await expect(failure(h.service.addUser('Bob_Two'))).resolves.toEqual({ code: 'invalid_input', message: '@bob_two is already on the list.' });
    await expect(failure(h.service.addUser('@x'))).resolves.toEqual({
      code: 'invalid_input',
      message: 'Invalid username: "@x" (5–32 characters a-z, 0-9, _)',
      fieldErrors: { allowedUsers: ['Invalid username: "@x" (5–32 characters a-z, 0-9, _)'] },
    });
    expect(h.notify.calls).toBe(0);
  });

  it('removes users but never the last one', async () => {
    const h = await configured();
    await expect(failure(h.service.removeUser('nobody_here'))).resolves.toEqual({
      code: 'invalid_input',
      message: '@nobody_here is not on the list.',
    });
    await expect(h.service.removeUser('@bob_two')).resolves.toMatchObject({ users: [{ username: 'alice_one' }] });
    await expect(failure(h.service.removeUser('alice_one'))).resolves.toEqual({ code: 'invalid_input', message: LAST_USER_MESSAGE });
  });

  it('unpairs a paired user and reports an unpaired one as unchanged', async () => {
    const h = await configured();
    await h.store.update((config) => ({
      ...config,
      allowedUsers: config.allowedUsers.map((user) => (user.username === 'alice_one' ? { ...user, userId: 7, pairedAt: '2026-09-14T09:00:00.000Z' } : user)),
    }));
    await expect(h.service.unpairUser('alice_one')).resolves.toMatchObject({
      users: [{ username: 'alice_one', paired: false, pairedAt: null }, { username: 'bob_two' }],
      reload: { kind: 'reloaded' },
    });
    await expect(h.service.unpairUser('alice_one')).resolves.toMatchObject({ reload: { kind: 'unchanged' } });
    expect(h.notify.calls).toBe(1);
  });

  it('reports a bot that could not be told', async () => {
    const h = await configured();
    h.notify.result = { kind: 'failed', code: 'timeout', message: 'Daemon did not respond after 5000 ms' };
    await expect(h.service.addUser('carol_three')).resolves.toMatchObject({
      reload: { kind: 'failed', message: 'Daemon did not respond after 5000 ms' },
    });
    h.notify.result = { kind: 'not_running' };
    await expect(h.service.addUser('dave_four')).resolves.toMatchObject({ reload: { kind: 'not_running' } });
  });
});
