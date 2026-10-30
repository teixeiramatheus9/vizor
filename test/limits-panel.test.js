import { describe, it, expect } from 'vitest';
import { renderLimitsPanel } from '../src/renderer/limits/limits-panel.js';
import { limitsLabel, renderStatusBar } from '../src/renderer/shell/status-bar.js';

const NOW = new Date(2026, 9, 29, 12, 0).getTime();
const win = (pct, resetsAt, history = [[NOW - 3600000, pct - 5], [NOW, pct]]) => ({ pct, resetsAt, seenAt: NOW, startedAt: NOW - 3600000, startPct: 0, history });
const snap = (over = {}) => ({
  windows: { fiveHour: win(62, new Date(2026, 9, 29, 15, 30).getTime()), sevenDay: win(40, new Date(2026, 9, 31, 9, 0).getTime()) },
  shares: { chats: [{ sessionId: 's1', cwd: '/p/alpha', pct: 20 }], outside: 5 },
  stale: false, seenAt: NOW,
  settings: { fiveHour: true, sevenDay: true, warnAt: 80, resetNotice: true, showInStatusBar: true },
  ...over,
});

describe('limitsLabel', () => {
  it('reads like 5h 62% · sem 40%', () => {
    expect(limitsLabel(snap(), NOW)).toMatchObject({ text: '5h 62% · sem 40%', level: 'ok' });
  });
  it('levels at 79 / 80 / 100', () => {
    const at = (pct) => limitsLabel(snap({ windows: { fiveHour: win(pct, NOW + 1000), sevenDay: null } }), NOW).level;
    expect(at(79)).toBe('ok');
    expect(at(80)).toBe('near');
    expect(at(100)).toBe('out');
  });
  it('stale says how long ago in the title', () => {
    const label = limitsLabel(snap({ stale: true, seenAt: NOW - 20 * 60000 }), NOW);
    expect(label.level).toBe('stale');
    expect(label.title).toContain('visto há 20 min');
  });
  it('omits expired and disabled windows', () => {
    expect(limitsLabel(snap({ windows: { fiveHour: win(62, NOW - 1), sevenDay: win(40, NOW + 1000) } }), NOW).text).toBe('sem 40%');
    expect(limitsLabel(snap({ settings: { ...snap().settings, sevenDay: false } }), NOW).text).toBe('5h 62%');
  });
  it('is null when hidden from the status bar', () => {
    expect(limitsLabel(snap({ settings: { ...snap().settings, showInStatusBar: false } }), NOW)).toBeNull();
    expect(renderStatusBar({ limits: null })).not.toContain('status-limits');
  });
  it('renders a button that opens the panel', () => {
    const html = renderStatusBar({ limits: limitsLabel(snap(), NOW) });
    expect(html).toContain('data-limits-toggle');
    expect(html).toContain('5h 62%');
  });
});

describe('renderLimitsPanel', () => {
  it('shows the local reset time, the weekday for weekly, ≈ per chat and fora do Vizor', () => {
    const html = renderLimitsPanel(snap(), NOW);
    expect(html).toContain('volta às 15:30');
    expect(html).toContain('volta sáb 09:00');
    expect(html).toContain('≈20%');
    expect(html).toContain('alpha');
    expect(html).toContain('fora do Vizor');
  });
  it('escapes chat names', () => {
    const html = renderLimitsPanel(snap(), NOW, { nameOf: () => '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('draws one path per window with history', () => {
    expect(renderLimitsPanel(snap(), NOW).match(/<path /g)).toHaveLength(2);
    const one = snap({ windows: { fiveHour: win(62, NOW + 1000, [[NOW, 62]]), sevenDay: win(40, NOW + 1000) } });
    expect(renderLimitsPanel(one, NOW).match(/<path /g)).toHaveLength(1);
  });
  it('has an empty state', () => {
    const html = renderLimitsPanel(snap({ windows: { fiveHour: null, sevenDay: null } }), NOW);
    expect(html).toContain('Ainda não vi nenhum chat do Claude desde que ativou');
  });
});
