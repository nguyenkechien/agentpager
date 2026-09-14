import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it.each([
    [[], { command: null, positionals: [], flags: {} }],
    [['users', 'add', '@alice'], { command: 'users', positionals: ['add', '@alice'], flags: {} }],
    [['start', '--foreground'], { command: 'start', positionals: [], flags: { foreground: true } }],
    [['logs', '--n', '30'], { command: 'logs', positionals: [], flags: { n: '30' } }],
    [['logs', '--n=40'], { command: 'logs', positionals: [], flags: { n: '40' } }],
    [['logs', '-f', '-n', '20'], { command: 'logs', positionals: [], flags: { f: true, n: '20' } }],
    [['logs', '-n20'], { command: 'logs', positionals: [], flags: { n: '20' } }],
    [['logs', '-n'], { command: 'logs', positionals: [], flags: { n: true } }],
    [['--version'], { command: null, positionals: [], flags: { version: true } }],
    [['config', 'set', 'projectsRoot', '--', '-weird'], { command: 'config', positionals: ['set', 'projectsRoot', '-weird'], flags: {} }],
  ])('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });
});
