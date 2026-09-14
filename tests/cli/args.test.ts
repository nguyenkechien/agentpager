import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it.each([
    [[], { command: null, positionals: [], flags: {} }],
    [['users', 'add', '@alice'], { command: 'users', positionals: ['add', '@alice'], flags: {} }],
    [['start', '--foreground'], { command: 'start', positionals: [], flags: { foreground: true } }],
    [['setup', '--import', 'D:\\Projects\\claude-pager'], { command: 'setup', positionals: [], flags: { import: 'D:\\Projects\\claude-pager' } }],
    [['setup', '--import=D:\\old'], { command: 'setup', positionals: [], flags: { import: 'D:\\old' } }],
    [['setup', '--import'], { command: 'setup', positionals: [], flags: { import: true } }],
    [['logs', '-f', '-n', '20'], { command: 'logs', positionals: [], flags: { f: true, n: '20' } }],
    [['logs', '-n20'], { command: 'logs', positionals: [], flags: { n: '20' } }],
    [['logs', '-n'], { command: 'logs', positionals: [], flags: { n: true } }],
    [['--version'], { command: null, positionals: [], flags: { version: true } }],
    [['config', 'set', 'projectsRoot', '--', '-weird'], { command: 'config', positionals: ['set', 'projectsRoot', '-weird'], flags: {} }],
  ])('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });
});
