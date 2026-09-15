import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliAbortError, createTerminalIo } from '../../src/cli/io.js';

function pipedIo(answers: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const written = { output: '', error: '' };
  output.on('data', (chunk: Buffer) => {
    written.output += chunk.toString();
  });
  error.on('data', (chunk: Buffer) => {
    written.error += chunk.toString();
  });
  input.end(answers);
  return { io: createTerminalIo({ input, output, error }), written };
}

describe('createTerminalIo with piped input', () => {
  it('answers consecutive questions from buffered lines', async () => {
    const { io, written } = pipedIo('123:token\r\n\n@alice, bob\ny\n');
    await expect(io.ask('Bot token: ', { hidden: true })).resolves.toBe('123:token');
    await expect(io.ask('Folder: ', { defaultValue: 'D:\\Projects' })).resolves.toBe('D:\\Projects');
    await expect(io.ask('Username: ')).resolves.toBe('@alice, bob');
    await expect(io.confirm('Start now?', false)).resolves.toBe(true);
    io.close();
    expect(written.output).toBe('Bot token: Folder: [D:\\Projects] Username: Start now? (y/N) ');
  });

  it('asks again after an unclear confirmation and uses the default for an empty one', async () => {
    const { io, written } = pipedIo('maybe\nno\n\n');
    await expect(io.confirm('Overwrite?', true)).resolves.toBe(false);
    await expect(io.confirm('Start at login?', true)).resolves.toBe(true);
    io.close();
    expect(written.error).toBe('Answer y or n.\n');
  });

  it('aborts when the input ends before an answer', async () => {
    const { io } = pipedIo('only-one\n');
    await expect(io.ask('first: ')).resolves.toBe('only-one');
    await expect(io.ask('second: ')).rejects.toBeInstanceOf(CliAbortError);
    io.close();
  });

  it('writes output and error lines', () => {
    const { io, written } = pipedIo('');
    io.out('hello');
    io.err('oops');
    io.close();
    expect(written).toEqual({ output: 'hello\n', error: 'oops\n' });
  });
});
