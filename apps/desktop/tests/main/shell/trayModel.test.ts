import { describe, expect, it } from 'vitest';
import { QUIT_LABEL, trayModel } from '../../../src/main/shell/trayModel.js';
import type { BadgeState, DaemonView } from '../../../src/shared/api.js';

function view(badge: BadgeState, botUsername: string | null = null): DaemonView {
  return { badge, pid: null, startedAt: null, workerPid: null, restarts: 0, botUsername, provider: null, lastError: null, launcher: null };
}

describe('trayModel', () => {
  it('shows a running bot in green with Stop and Restart', () => {
    expect(trayModel(view('running', 'test_bot'))).toEqual({
      color: 'green',
      tooltip: 'agentpager — Đang chạy · @test_bot',
      statusLine: 'Đang chạy · @test_bot',
      items: [
        { action: 'open', label: 'Mở agentpager', enabled: true },
        { action: 'stop', label: 'Stop', enabled: true },
        { action: 'restart', label: 'Restart', enabled: true },
        { action: 'quit', label: QUIT_LABEL, enabled: true },
      ],
    });
  });

  it('offers Start for a stopped or failed bot', () => {
    for (const [badge, color, line] of [
      ['stopped', 'grey', 'Đã dừng'],
      ['error', 'red', 'Lỗi'],
    ] as const) {
      const model = trayModel(view(badge));
      expect(model.color).toBe(color);
      expect(model.statusLine).toBe(line);
      expect(model.items.map((item) => [item.action, item.enabled])).toEqual([
        ['open', true],
        ['start', true],
        ['restart', false],
        ['quit', true],
      ]);
    }
  });

  it('colours transitions amber and unreachable daemons red, keeping Stop available', () => {
    expect(trayModel(view('starting')).color).toBe('amber');
    expect(trayModel(view('restarting')).statusLine).toBe('Đang khởi động lại');
    expect(trayModel(view('unresponsive'))).toMatchObject({ color: 'red', statusLine: 'Bot không phản hồi' });
    expect(trayModel(view('disconnected')).items.map((item) => item.action)).toEqual(['open', 'stop', 'restart', 'quit']);
    expect(trayModel(view('running')).statusLine).toBe('Đang chạy');
  });

  it('waits for the first status read', () => {
    expect(trayModel(null)).toMatchObject({ color: 'grey', statusLine: 'Đang đọc trạng thái…' });
    expect(trayModel(null).items.filter((item) => !item.enabled).map((item) => item.action)).toEqual(['start', 'restart']);
  });
});
