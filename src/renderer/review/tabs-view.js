import { escapeHtml } from '../workspace-view.js';

export const REVIEW_TABS = [['summary', 'Resumo'], ['changes', 'Mudanças'], ['impact', 'Impacto'], ['live', 'Ao vivo']];

export function renderReviewTabs(active) {
  return REVIEW_TABS.map(([id, label]) => `<button class="review-tab${id === active ? ' active' : ''}" data-review-tab="${id}" aria-selected="${id === active}">${escapeHtml(label)}</button>`).join('');
}
