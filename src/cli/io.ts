import { stderr, stdin, stdout } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

export interface AskOptions {
  /** Do not echo what is typed (bot token). */
  hidden?: boolean;
  /** Returned when the answer is empty; shown in brackets. */
  defaultValue?: string;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string, options?: AskOptions) => Promise<string>;
  confirm: (question: string, defaultYes: boolean) => Promise<boolean>;
}

export interface TerminalStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
}

/** The user pressed Ctrl+C or the input ended while a question was open. */
export class CliAbortError extends Error {
  constructor() {
    super('Đã huỷ');
    this.name = 'CliAbortError';
  }
}

const CTRL_C = '';
const BACKSPACE = new Set(['', '\b']);
const YES = new Set(['y', 'yes', 'c', 'co', 'có']);
const NO = new Set(['n', 'no', 'k', 'khong', 'không']);

/**
 * Terminal prompts. With a TTY every question gets its own readline interface (and raw mode for hidden
 * input). Without one (piped answers, a parent app), a single interface buffers lines: one interface per
 * question would read the whole pipe and drop the remaining answers when it closes.
 */
export function createTerminalIo(streams: TerminalStreams = { input: stdin, output: stdout, error: stderr }): CliIo & { close(): void } {
  const { input, output, error } = streams;
  const interactive = input.isTTY === true;
  let piped: { rl: Interface; lines: AsyncIterator<string> } | null = null;

  const readPipedLine = async (prompt: string): Promise<string> => {
    if (!piped) {
      const rl = createInterface({ input, terminal: false, crlfDelay: Infinity });
      piped = { rl, lines: rl[Symbol.asyncIterator]() };
    }
    output.write(prompt);
    const next = await piped.lines.next();
    if (next.done === true) throw new CliAbortError();
    return next.value;
  };

  const readVisibleLine = (prompt: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true });
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        rl.close();
        finish();
      };
      rl.on('SIGINT', () => {
        settle(() => {
          reject(new CliAbortError());
        });
      });
      rl.on('close', () => {
        settle(() => {
          reject(new CliAbortError());
        });
      });
      rl.question(prompt).then(
        (answer) => {
          settle(() => {
            resolve(answer);
          });
        },
        (failure: unknown) => {
          settle(() => {
            reject(failure instanceof Error ? failure : new Error(String(failure)));
          });
        },
      );
    });

  const readHiddenLine = (prompt: string): Promise<string> => {
    const setRawMode = input.setRawMode;
    if (!setRawMode) return readVisibleLine(prompt);
    output.write(prompt);
    return new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = (): void => {
        input.off('data', onData);
        setRawMode.call(input, false);
        input.pause();
        output.write('\n');
      };
      const onData = (chunk: string | Buffer): void => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') {
            cleanup();
            resolve(value);
            return;
          }
          if (char === CTRL_C) {
            cleanup();
            reject(new CliAbortError());
            return;
          }
          if (BACKSPACE.has(char)) value = value.slice(0, -1);
          else value += char;
        }
      };
      input.setEncoding('utf8');
      setRawMode.call(input, true);
      input.resume();
      input.on('data', onData);
    });
  };

  const ask = async (question: string, options: AskOptions = {}): Promise<string> => {
    const prompt = options.defaultValue ? `${question}[${options.defaultValue}] ` : question;
    let answer: string;
    if (!interactive) answer = await readPipedLine(prompt);
    else if (options.hidden) answer = await readHiddenLine(prompt);
    else answer = await readVisibleLine(prompt);
    answer = answer.trim();
    return answer === '' && options.defaultValue !== undefined ? options.defaultValue : answer;
  };

  return {
    out: (line) => {
      output.write(`${line}\n`);
    },
    err: (line) => {
      error.write(`${line}\n`);
    },
    ask,
    confirm: async (question, defaultYes) => {
      for (;;) {
        const answer = (await ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `)).toLowerCase();
        if (answer === '') return defaultYes;
        if (YES.has(answer)) return true;
        if (NO.has(answer)) return false;
        error.write('Trả lời y hoặc n.\n');
      }
    },
    close: () => {
      piped?.rl.close();
      piped = null;
    },
  };
}
