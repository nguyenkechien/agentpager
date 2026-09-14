import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Works from src/ under tsx and from any dist/ layout: the nearest folder with package.json is the package. */
export function findPackageRoot(startDir: string, exists: (path: string) => boolean = existsSync): string {
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${startDir}`);
    dir = parent;
  }
}

const manifestSchema = z.object({ version: z.string().min(1) });

export async function readPackageVersion(packageRoot: string): Promise<string> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
  return manifest.version;
}
