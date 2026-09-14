import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

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

/** The user pressed Ctrl+C or closed the input while a question was open. */
export class CliAbortError extends Error {
  constructor() {
    super('Đã huỷ');
    this.name = 'CliAbortError';
  }
}

const CTRL_C = '';
const BACKSPACE = new Set(['', '\b']);

function askVisible(question: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
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
    rl.question(question).then(
      (answer) => {
        settle(() => {
          resolve(answer);
        });
      },
      (error: unknown) => {
        settle(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );
  });
}

function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) return askVisible(question);
  stdout.write(question);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
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
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const YES = new Set(['y', 'yes', 'c', 'co', 'có']);
const NO = new Set(['n', 'no', 'k', 'khong', 'không']);

export function createTerminalIo(): CliIo {
  const ask = async (question: string, options: AskOptions = {}): Promise<string> => {
    const prompt = options.defaultValue ? `${question}[${options.defaultValue}] ` : question;
    const answer = (options.hidden ? await askHidden(prompt) : await askVisible(prompt)).trim();
    return answer === '' && options.defaultValue !== undefined ? options.defaultValue : answer;
  };

  return {
    out: (line) => {
      stdout.write(`${line}\n`);
    },
    err: (line) => {
      stderr.write(`${line}\n`);
    },
    ask,
    confirm: async (question, defaultYes) => {
      for (;;) {
        const answer = (await ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'} `)).toLowerCase();
        if (answer === '') return defaultYes;
        if (YES.has(answer)) return true;
        if (NO.has(answer)) return false;
        stderr.write('Trả lời y hoặc n.\n');
      }
    },
  };
}
