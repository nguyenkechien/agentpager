#!/usr/bin/env node
import { findPackageRoot, readPackageVersion } from '../daemon/packageRoot.js';
import { appPaths, currentPlatform } from '../platform/paths.js';
import { stableExecutablePath } from '../platform/realPath.js';
import { createCliDeps } from './deps.js';
import { createTerminalIo } from './io.js';
import { runCli } from './run.js';

/** Log destinations can keep the event loop alive after a command has finished. */
const EXIT_GRACE_MS = 2_000;

async function main(): Promise<number> {
  const platform = currentPlatform();
  const paths = appPaths(platform);
  const packageRoot = findPackageRoot(import.meta.dirname);
  const deps = createCliDeps({
    paths,
    platform,
    packageRoot,
    cliPath: stableExecutablePath(import.meta.filename),
    nodePath: stableExecutablePath(process.execPath),
    version: await readPackageVersion(packageRoot),
  });
  const io = createTerminalIo();
  try {
    return await runCli(process.argv.slice(2), io, deps);
  } finally {
    io.close();
  }
}

main()
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    },
  )
  .finally(() => {
    setTimeout(() => {
      process.exit();
    }, EXIT_GRACE_MS).unref();
  });
