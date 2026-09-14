import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_SNAPSHOTS = 20;
const MAX_SUBDIRECTORIES = 90;

export interface ProjectSnapshot {
  id: string;
  dirs: string[];
}

/** Keeps short-lived directory listings so inline buttons can reference a directory by index. */
export class ProjectPicker {
  private readonly snapshots = new Map<string, string[]>();

  constructor(
    private readonly root: string,
    private readonly newId: () => string = () => randomBytes(3).toString('hex'),
  ) {}

  async open(): Promise<ProjectSnapshot> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const subdirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, MAX_SUBDIRECTORIES)
      .map((name) => join(this.root, name));

    const snapshot = { id: this.newId(), dirs: [this.root, ...subdirs] };
    this.snapshots.set(snapshot.id, snapshot.dirs);
    for (const id of this.snapshots.keys()) {
      if (this.snapshots.size <= MAX_SNAPSHOTS) break;
      this.snapshots.delete(id);
    }
    return snapshot;
  }

  resolve(id: string, index: number): string | null {
    return this.snapshots.get(id)?.[index] ?? null;
  }
}
