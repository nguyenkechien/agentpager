import { ConfigError, normalizeUsername } from '@chiennguyen/agentpager/config';
import { describe, expect, it } from 'vitest';
import { checkUsername } from '../../src/shared/usernames.js';

function core(input: string): { ok: true; username: string } | { ok: false; message: string } {
  try {
    return { ok: true, username: normalizeUsername(input) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, message: error.issues.join('; ') };
  }
}

describe('checkUsername', () => {
  it('matches the core rule and message for every kind of input', () => {
    for (const input of ['@Alice_One', ' bob_two ', 'carol', '@x', 'has space', 'dấu_tiếng', 'a'.repeat(32), 'a'.repeat(33), '', '@@alice_one']) {
      expect(checkUsername(input), JSON.stringify(input)).toEqual(core(input));
    }
  });
});
