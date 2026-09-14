import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../src/core/systemPrompt.js';
import { FULL_CAPABILITIES } from '../support/fakeProvider.js';

describe('buildSystemPrompt', () => {
  it('describes every tool of a full-featured provider', () => {
    const prompt = buildSystemPrompt(FULL_CAPABILITIES);
    expect(prompt).toContain('Telegram bot (agentpager)');
    expect(prompt).toContain('send_file tool');
    expect(prompt).toContain('multiple-choice question tool');
    expect(prompt).toContain('A guard blocks');
    expect(prompt).not.toContain('Files cannot be sent');
  });

  it('only mentions what a limited provider can do', () => {
    const prompt = buildSystemPrompt({ ...FULL_CAPABILITIES, fileSendTool: false, askUser: false, commandGuard: false });
    expect(prompt).toContain('Files cannot be sent from this session');
    expect(prompt).not.toContain('send_file');
    expect(prompt).not.toContain('question tool');
    expect(prompt).not.toContain('guard');
  });
});
