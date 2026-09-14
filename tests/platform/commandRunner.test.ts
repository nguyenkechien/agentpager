import { describe, expect, it } from 'vitest';
import { nodeCommandRunner } from '../../src/platform/commandRunner.js';

describe('nodeCommandRunner', () => {
  it('returns output and a non-zero exit code without throwing', async () => {
    await expect(
      nodeCommandRunner.run(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']),
    ).resolves.toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('returns code 0 on success', async () => {
    await expect(nodeCommandRunner.run(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toEqual({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });
  });

  it('rejects when the program cannot be started', async () => {
    await expect(nodeCommandRunner.run('agentpager-command-that-does-not-exist', [])).rejects.toThrow();
  });
});
