// The one-line status bar at the bottom of the window: today's manager tokens
// against the cap, how many agents work and wait, and the next automation.
// Pure: workspace.js redraws it when the state arrives or tokens are spent.
import { escapeHtml } from '../workspace-view.js';
import { limitsLabel } from '../limits/limits-panel.js';

const compact = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

export function tokensLabel({ used = 0, cap = 0 } = {}) {
  // A cap of 0 is the user's permanent economy mode: say so instead of "x/0".
  if (!(cap > 0)) return `tokens hoje: ${compact(used)} · economia`;
  return `tokens hoje: ${compact(used)} / ${compact(cap)}`;
}

export function agentsLabel({ working = 0, waiting = 0 } = {}) {
  if (!working && !waiting) return 'nenhum agente ativo';
  const parts = [];
  if (working) parts.push(`${working} rodando`);
  if (waiting) parts.push(`${waiting} esperando`);
  return parts.join(' · ');
}

// nextAutomation: { at: 'HH:MM' } once the Automações exist; null shows nothing.
export { limitsLabel };

// limits: limitsLabel() result or null.
export function renderStatusBar({ tokens = {}, agents = {}, nextAutomation = null, limits = null } = {}) {
  const over = tokens.cap > 0 && tokens.used >= tokens.cap;
  const items = [
    `<span class="status-item status-tokens${over ? ' over' : ''}">${escapeHtml(tokensLabel(tokens))}</span>`,
    `<button class="status-item status-agents${agents.waiting ? ' waiting' : ''}" data-top-tab="agents" title="Abrir Agentes">${escapeHtml(agentsLabel(agents))}</button>`,
  ];
  if (limits?.text) items.push(`<button type="button" class="status-item status-limits ${escapeHtml(limits.level)}" data-limits-toggle aria-haspopup="dialog" title="${escapeHtml(limits.title)}">${escapeHtml(limits.text)}</button>`);
  if (nextAutomation?.at) items.push(`<span class="status-item status-next">próxima automação: ${escapeHtml(nextAutomation.at)}</span>`);
  return items.join('<span class="status-sep" aria-hidden="true">·</span>');
}
