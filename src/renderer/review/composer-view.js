// The review's comment composer: who it goes to, what it is about, the draft.
import { escapeHtml } from '../workspace-view.js';

const range = (from, to) => (to > from ? `linhas ${from}–${to}` : `linha ${from}`);

// Mirrors the header compose.js sends, so what is shown is what is attached.
export function describeContext(context) {
  if (!context) return '';
  if (context.kind === 'hunk') {
    if (!(context.newLines >= 1)) return `hunk de ${context.path}, perto da linha ${context.newStart}`;
    return `hunk de ${context.path}, ${range(context.newStart, context.newStart + context.newLines - 1)}`;
  }
  if (context.kind === 'file') return `arquivo ${context.path}`;
  if (context.kind === 'node') {
    const at = Number.isInteger(context.startLine) ? `, ${range(context.startLine, Number.isInteger(context.endLine) ? context.endLine : context.startLine)}` : '';
    return `${context.label} (${context.path}${at})`;
  }
  return '';
}

export function renderComposer({ target = {}, context = null, draft = '', error = '' } = {}) {
  const sessions = target.sessions ?? [];
  const who = sessions.length > 1
    ? `<select class="composer-target" data-composer="target">${sessions.map((s) => `<option value="${escapeHtml(s.id)}"${s.label === target.sessionLabel ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>`
    : `<span class="composer-target">${escapeHtml(target.sessionLabel ?? '')}</span>`;
  const text = describeContext(context);
  const about = text
    ? `<div class="composer-context">contexto: ${escapeHtml(text)} · <button class="composer-clear" data-composer="clear">limpar</button></div>`
    : '';
  const err = error ? `<div class="composer-error">${escapeHtml(error)}</div>` : '';
  return `<div class="review-composer"><div class="composer-to">para: ${who}</div>${about}<textarea class="composer-draft" data-composer="draft" rows="3" placeholder="Comente com o agente…">${escapeHtml(draft)}</textarea>${err}<button class="composer-send" data-composer="send">Enviar</button></div>`;
}
