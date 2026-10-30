import { escapeHtml } from '../workspace-view.js';

// Loading placeholder: shape-only rows.
export function skeleton(kind = 'list', rows = 3) {
  const row = '<div class="skeleton-row"><span class="skeleton-bar"></span><span class="skeleton-bar short"></span></div>';
  return `<div class="skeleton skeleton-${escapeHtml(kind)}" aria-hidden="true">${row.repeat(Math.max(0, rows))}</div>`;
}
