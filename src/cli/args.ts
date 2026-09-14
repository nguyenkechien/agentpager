export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | true>;
}

/** Flags that take the next argument as their value. */
const VALUE_FLAGS = new Set(['import', 'n']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = argv[index + 1];

    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const separator = body.indexOf('=');
      if (separator >= 0) {
        flags[body.slice(0, separator)] = body.slice(separator + 1);
      } else if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      const name = arg.slice(1, 2);
      const rest = arg.slice(2);
      if (VALUE_FLAGS.has(name)) {
        if (rest !== '') {
          flags[name] = rest;
        } else if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          index += 1;
        } else {
          flags[name] = true;
        }
      } else {
        for (const letter of arg.slice(1)) flags[letter] = true;
      }
      continue;
    }
    if (command === null) command = arg;
    else positionals.push(arg);
  }

  return { command, positionals, flags };
}
