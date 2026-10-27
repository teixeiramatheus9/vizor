import { describe, it, expect } from 'vitest';
import { renderStatusBar, tokensLabel, agentsLabel } from '../src/renderer/shell/status-bar.js';

describe('status bar', () => {
  it('shows tokens against the cap', () => {
    expect(tokensLabel({ used: 1500, cap: 50000 })).toBe('tokens hoje: 1.5k / 50k');
  });
  it('without a cap it says economy instead of x/0', () => {
    expect(tokensLabel({ used: 300, cap: 0 })).toBe('tokens hoje: 300 · economia');
  });
  it('marks the meter when the cap is reached', () => {
    expect(renderStatusBar({ tokens: { used: 100, cap: 100 }, agents: {} })).toContain('status-tokens over');
    expect(renderStatusBar({ tokens: { used: 10, cap: 100 }, agents: {} })).not.toContain(' over');
  });
  it('counts agents and the agents part opens the Agentes tab', () => {
    expect(agentsLabel({ working: 2, waiting: 1 })).toBe('2 rodando · 1 esperando');
    expect(agentsLabel({ working: 0, waiting: 0 })).toBe('nenhum agente ativo');
    expect(renderStatusBar({ tokens: { used: 0, cap: 0 }, agents: { working: 1, waiting: 0 } })).toContain('data-top-tab="agents"');
  });
  it('shows nothing about automations while there are none', () => {
    expect(renderStatusBar({ tokens: { used: 0, cap: 0 }, agents: {}, nextAutomation: null })).not.toContain('automação');
    expect(renderStatusBar({ tokens: { used: 0, cap: 0 }, agents: {}, nextAutomation: { at: '14:00' } })).toContain('próxima automação: 14:00');
  });
});
