import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | { types: string; default: string }>;
};

describe('package entry points', () => {
  it('map every entry to a source barrel with matching types', () => {
    const entries = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
    expect(entries.map(([key]) => key)).toEqual(['./config', './control', './daemon', './platform', './providers']);
    for (const [, target] of entries) {
      if (typeof target === 'string') throw new Error('entry points must declare types');
      expect(target.types).toBe(target.default.replace(/\.js$/, '.d.ts'));
      const source = join(root, target.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
      expect(existsSync(source), source).toBe(true);
    }
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  it('expose what the desktop app imports', async () => {
    const config = await import('../../src/core/config/index.js');
    const control = await import('../../src/control/index.js');
    const daemon = await import('../../src/daemon/index.js');
    const platform = await import('../../src/platform/index.js');
    const providers = await import('../../src/providers/index.js');
    expect(Object.keys(config)).toEqual(
      expect.arrayContaining(['ConfigStore', 'ConfigError', 'validateConfig', 'normalizeUsername', 'maskToken', 'MISSING_CONFIG_MESSAGE', 'LOG_LEVELS']),
    );
    expect(Object.keys(control)).toEqual(
      expect.arrayContaining([
        'startDaemon',
        'stopDaemon',
        'restartDaemon',
        'readDaemonStatus',
        'notifyUsersChanged',
        'followLog',
        'readLogTail',
        'formatLogLine',
        'lastDaemonFatal',
      ]),
    );
    expect(Object.keys(daemon)).toEqual(
      expect.arrayContaining(['runDaemon', 'readDaemonInfo', 'ipcRequest', 'IpcError', 'findPackageRoot', 'readPackageVersion', 'FATAL_WORKER_LOG']),
    );
    expect(Object.keys(platform)).toEqual(
      expect.arrayContaining(['appPaths', 'currentPlatform', 'createAutostart', 'defaultAutostartDeps', 'stableExecutablePath']),
    );
    expect(Object.keys(providers)).toEqual(expect.arrayContaining(['providerCatalog', 'findCatalogEntry']));
  });
});
