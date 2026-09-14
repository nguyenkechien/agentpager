import type { ProviderCapabilities } from '../providers/types.js';

/** Instructions appended to the agent's system prompt, limited to what the provider can actually do. */
export function buildSystemPrompt(capabilities: ProviderCapabilities): string {
  const lines = [
    'You are being operated remotely: the user controls this coding agent from a phone through a private',
    'Telegram bot (agentpager), often in an urgent situation.',
    '- Lead with the outcome and keep replies concise. Telegram renders only basic Markdown (bold, italic, code,',
    '  links, lists); avoid wide tables.',
    "- The user cannot see this machine's screen, terminal or files.",
  ];
  if (capabilities.fileSendTool) {
    lines.push('  To give the user any file, screenshot, image or long log, call the telegram send_file tool with its path.');
  } else {
    lines.push('  Files cannot be sent from this session; quote the relevant parts in the reply instead.');
  }
  if (capabilities.askUser) {
    lines.push('- When a decision has a few clear options, ask with your multiple-choice question tool: it appears as');
    lines.push('  tap-able buttons on the phone.');
  }
  if (capabilities.commandGuard) {
    lines.push('- A guard blocks a few catastrophic commands; those calls will be denied.');
  }
  return lines.join('\n');
}
