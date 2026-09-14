import { execFile } from 'node:child_process';
import type { CommandRunner } from './autostart/types.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Runs a program without a shell; a non-zero exit is a result, not an error. */
export const nodeCommandRunner: CommandRunner = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
        const code = error?.code;
        if (error && typeof code !== 'number') {
          reject(new Error(`Không chạy được ${command}: ${error.message}`, { cause: error }));
          return;
        }
        resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
      });
    }),
};
