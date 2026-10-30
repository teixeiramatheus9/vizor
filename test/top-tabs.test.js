import { describe, it, expect } from 'vitest';
import { TOP_TABS, normalizeTopTab, topTabTitle, renderTopTabs } from '../src/renderer/shell/top-tabs.js';

describe('top tabs', () => {
  it('has Workspace, Agentes, GitHub and Automações, in that order', () => {
    expect(TOP_TABS.map((tab) => tab.id)).toEqual(['workspace', 'agents', 'github', 'automations']);
  });

  it('puts the waiting count in the Agentes title only when someone is waiting', () => {
    expect(topTabTitle('agents', { waiting: 2 })).toBe('Agentes · 2 esperando');
    expect(topTabTitle('agents', { waiting: 0 })).toBe('Agentes');
    expect(topTabTitle('agents', {})).toBe('Agentes');
    expect(topTabTitle('github', { waiting: 3 })).toBe('GitHub');
    expect(topTabTitle('workspace', { waiting: 3 })).toBe('Workspace');
  });

  it('falls back to workspace for anything it does not know', () => {
    expect(normalizeTopTab('github')).toBe('github');
    expect(normalizeTopTab('nope')).toBe('workspace');
    expect(normalizeTopTab(undefined)).toBe('workspace');
  });

  it('renders one button per tab and marks the active one', () => {
    const html = renderTopTabs('agents', { waiting: 1 });
    expect(html.match(/data-top-tab=/g)).toHaveLength(4);
    expect(html).toContain('data-top-tab="agents" aria-selected="true"');
    expect(html).toContain('data-top-tab="github" aria-selected="false"');
    expect(html).toContain('Agentes · 1 esperando');
    expect(html).toContain('Ctrl+1');
    expect(html).toContain('data-top-tab="automations" aria-selected="false"');
    expect(html).toContain('Ctrl+4');
    expect(html).toContain('Automações');
  });
});
