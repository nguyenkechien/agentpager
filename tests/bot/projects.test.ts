import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SNAPSHOTS, ProjectPicker } from '../../src/bot/projects.js';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pager-projects-'));
  for (const name of ['beta', 'Alpha', '.git', 'node_modules']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'notes.txt'), '');
  return root;
}

describe('ProjectPicker', () => {
  it('lists the root plus visible subdirectories sorted by name', async () => {
    const root = makeRoot();
    const picker = new ProjectPicker(root, () => 'id1');
    await expect(picker.open()).resolves.toEqual({
      id: 'id1',
      dirs: [root, join(root, 'Alpha'), join(root, 'beta')],
    });
    expect(picker.resolve('id1', 2)).toBe(join(root, 'beta'));
    expect(picker.resolve('id1', 3)).toBeNull();
    expect(picker.resolve('other', 0)).toBeNull();
  });

  it('forgets the oldest snapshots beyond the cap', async () => {
    let counter = 0;
    const picker = new ProjectPicker(makeRoot(), () => `s${++counter}`);
    for (let i = 0; i <= MAX_SNAPSHOTS; i += 1) await picker.open();
    expect(picker.resolve('s1', 0)).toBeNull();
    expect(picker.resolve('s2', 0)).not.toBeNull();
    expect(picker.resolve(`s${MAX_SNAPSHOTS + 1}`, 0)).not.toBeNull();
  });
});
