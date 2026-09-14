import { describe, expect, it } from 'vitest';
import { toSessionInfo } from '../../../src/providers/claude-code/history.js';

describe('toSessionInfo', () => {
  it('prefers the custom title over the summary', () => {
    expect(
      toSessionInfo({ sessionId: 's1', summary: 'auto summary', customTitle: 'Named', lastModified: 5, cwd: 'D:\\a' }),
    ).toEqual({ sessionId: 's1', title: 'Named', cwd: 'D:\\a', lastModified: 5 });
  });

  it('uses the summary and a null cwd when they are missing', () => {
    expect(toSessionInfo({ sessionId: 's2', summary: 'auto summary', lastModified: 6 })).toEqual({
      sessionId: 's2',
      title: 'auto summary',
      cwd: null,
      lastModified: 6,
    });
  });
});
