import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProviderCatalogEntry } from '../../providers/types.js';
import { pathExists } from '../../util/fs.js';
import { ConfigError, validateConfig, type AgentpagerConfig } from './schema.js';

export const MISSING_CONFIG_MESSAGE = 'No config yet — run "agentpager setup".';
const FILE_MODE = 0o600;

export interface ConfigStoreDeps {
  platform: NodeJS.Platform;
  catalog: readonly ProviderCatalogEntry[];
}

/** config.json is shared by the CLI and the running worker, so every change re-reads the file first. */
export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly deps: ConfigStoreDeps,
  ) {}

  exists(): Promise<boolean> {
    return pathExists(this.filePath);
  }

  async read(): Promise<AgentpagerConfig> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError([MISSING_CONFIG_MESSAGE]);
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError([`${this.filePath} is not valid JSON: ${(error as Error).message}`]);
    }
    return validateConfig(raw, this.deps.catalog);
  }

  async write(config: AgentpagerConfig): Promise<void> {
    const valid = validateConfig(config, this.deps.catalog);
    await mkdir(dirname(this.filePath), { recursive: true });
    // A unique temp name keeps a CLI write and a worker write from clobbering each other's temp file.
    const tmpPath = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(valid, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
      if (this.deps.platform !== 'win32') await chmod(tmpPath, FILE_MODE);
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  /** Read-modify-write, serialized per store instance. */
  update(mutate: (current: AgentpagerConfig) => AgentpagerConfig): Promise<AgentpagerConfig> {
    const run = this.queue.then(async () => {
      const next = mutate(await this.read());
      await this.write(next);
      return next;
    });
    // The queue only orders updates; each caller still receives its own failure through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
