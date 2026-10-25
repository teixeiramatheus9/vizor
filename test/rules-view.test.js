import { describe, it, expect } from 'vitest';
import { renderHistory, renderReview, renderStatus } from '../src/renderer/rules-view.js';

const status = (overrides = {}) => ({ enabled: true, installed: true, offline: true, active: 4, pending: 2, unreadable: false, ...overrides });

describe('renderStatus', () => {
  it('says the lock is on, with active and pending counts', () => {
    const html = renderStatus(status());
    expect(html).toContain('trava ligada');
    expect(html).toContain('4 ativas');
    expect(html).toContain('2 esperando revisão');
    expect(html).not.toContain('status-off');
  });

  it('turns red when disabled or unreadable', () => {
    expect(renderStatus(status({ enabled: false }))).toContain('status-off');
    expect(renderStatus(status({ unreadable: true }))).toContain('trava desligada');
  });

  it('warns when the lock only works with the Vizor open', () => {
    expect(renderStatus(status({ offline: false }))).toContain('só funciona com o Vizor aberto');
  });

  it('no warning before the lock is installed', () => {
    expect(renderStatus(status({ installed: false, offline: false }))).not.toContain('só funciona com o Vizor aberto');
  });
});

describe('renderReview', () => {
  const scope = {
    scope: 'global',
    pending: ['linha nova', 'outra'],
    drafts: [
      { id: 'd1', source: 'push na main', kind: 'ask', irreversible: true, explain: 'push na principal', match: [] },
      { id: 'd2', source: 'sem co-autoria', kind: 'agent', irreversible: false, explain: '', match: [] },
    ],
    approved: [{ id: 'a1', source: 'drop <b>', kind: 'forbid', irreversible: true, explain: 'drop', match: [] }],
  };

  it('shows a banner with how many lines wait, and each draft with its kind', () => {
    const html = renderReview(scope);
    expect(html).toContain('2 regras esperando revisão');
    expect(html).toContain('entendi assim:');
    expect(html).toContain('perguntar');
    expect(html).toContain('sem volta');
    expect(html).toContain('pros agentes · sem trava');
    for (const action of ['approve', 'edit', 'discard']) expect(html).toContain(`data-rule-action="${action}"`);
  });

  it('lists approved rules and escapes their text', () => {
    const html = renderReview(scope);
    expect(html).toContain('proibido');
    expect(html).toContain('drop &lt;b&gt;');
    expect(html).not.toContain('drop <b>');
  });
});

describe('renderHistory', () => {
  it('lists outcomes newest first as given, escaped', () => {
    const html = renderHistory([{ at: Date.parse('2026-10-24T10:00:00'), ruleSource: 'r', summary: '<x>', outcome: 'barrado' }]);
    expect(html).toContain('barrado');
    expect(html).toContain('&lt;x&gt;');
  });

  it('says when nothing happened yet', () => {
    expect(renderHistory([])).toContain('nada barrado nem perguntado ainda');
  });
});
