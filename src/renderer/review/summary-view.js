// The review's Resumo tab: the verdict strip and the summary page. Pure strings;
// the plan and the backstage arrive already rendered (renderPlan, renderBackstage)
// so they are never duplicated here.
import { escapeHtml } from '../workspace-view.js';

const TONES = new Set(['ok', 'bad', 'warn', 'muted']);

export function renderVerdict(items) {
  return (items ?? []).map((item) => {
    const tone = TONES.has(item.tone) ? item.tone : 'muted';
    return `<span class="verdict-item tone-${tone}" data-verdict="${escapeHtml(item.key)}">${escapeHtml(item.text)}</span>`;
  }).join('');
}

export function renderSummary({ verdict, request, planHtml, backstageHtml, backstageOpen } = {}) {
  const ask = request ? `<section class="summary-request"><h3>O que foi pedido</h3><p>${escapeHtml(request)}</p></section>` : '';
  const backstage = backstageHtml
    ? `<details class="summary-backstage" data-backstage${backstageOpen ? ' open' : ''}><summary>Bastidores</summary>${backstageHtml}</details>`
    : '';
  return `<div class="review-summary"><div class="verdict-strip">${renderVerdict(verdict)}</div>${ask}${planHtml ?? ''}${backstage}</div>`;
}
