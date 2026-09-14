import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { exitQuietlyOnBrokenPipe } from '../../src/cli/brokenPipe.js';

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('exitQuietlyOnBrokenPipe', () => {
  it('exits without a stack trace when the reader closed the pipe', () => {
    const stream = new PassThrough();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);
    stream.emit('error', streamError('EPIPE'));
    expect(exit).toHaveBeenCalledOnce();
  });

  it('rethrows any other stream error', () => {
    const stream = new PassThrough();
    const exit = vi.fn();
    exitQuietlyOnBrokenPipe(stream, exit);
    expect(() => stream.emit('error', streamError('EIO'))).toThrow('write EIO');
    expect(exit).not.toHaveBeenCalled();
  });
});
