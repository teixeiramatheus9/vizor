// The window's top tabs: Workspace (today's screen), Agentes and GitHub.
// Pure: workspace.js draws the strip and shows one view at a time.
import { escapeHtml } from '../workspace-view.js';

export const TOP_TABS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'agents', label: 'Agentes' },
  { id: 'github', label: 'GitHub' },
];

export const normalizeTopTab = (id) => (TOP_TABS.some((tab) => tab.id === id) ? id : 'workspace');

export function topTabTitle(id, { waiting = 0 } = {}) {
  const label = TOP_TABS.find((tab) => tab.id === id)?.label ?? id;
  return id === 'agents' && waiting > 0 ? `${label} · ${waiting} esperando` : label;
}

export function renderTopTabs(active, counts = {}) {
  return TOP_TABS.map(
    (tab, index) =>
      `<button class="top-tab${tab.id === active ? ' active' : ''}" role="tab" data-top-tab="${tab.id}" aria-selected="${tab.id === active}" title="Ctrl+${index + 1}">${escapeHtml(topTabTitle(tab.id, counts))}</button>`,
  ).join('');
}
