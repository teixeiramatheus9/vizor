// Pure HTML builder for the Agents tab's kanban. No DOM access; everything
// from a session or a project goes through escapeHtml.
import { escapeHtml } from '../workspace-view.js';
import { renderGuardCard } from '../guard-card.js';
import { monogramColor, monogramOf } from '../project-accent.js';

export const COLUMN_TITLES = {
  waiting: 'Esperando você',
  working: 'Trabalhando',
  done: 'Terminou',
  idle: 'Ociosa',
  failed: 'Falhou',
};
const ORDER = ['waiting', 'working', 'done', 'idle', 'failed'];

const ACTION_LABELS = {
  focus: 'Abrir',
  answer: 'Responder',
  approve: 'Aprovar',
  interrupt: 'Interromper',
  dismiss: 'Dispensar',
};

// "há 4 min" from a past timestamp.
export function agoLabel(since, now) {
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

// projects: root -> { name, uri, accent } (the workspace's avatar pick).
function avatar(card, projects) {
  const project = projects?.[card.avatarKey];
  const name = project?.name ?? String(card.avatarKey ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (String(project?.uri ?? '').startsWith('data:image/')) return `<img class="kb-avatar" src="${escapeHtml(project.uri)}" alt="" width="18" height="18" />`;
  return `<span class="kb-avatar mono" style="background:${escapeHtml(project?.accent ?? monogramColor(name))}" aria-hidden="true">${escapeHtml(monogramOf(name))}</span>`;
}

function renderCard(card, projects, now) {
  const id = escapeHtml(card.id);
  const accent = projects?.[card.avatarKey]?.accent;
  const buttons = (card.actions ?? [])
    .filter((action) => Object.hasOwn(ACTION_LABELS, action))
    .map((action) => `<button type="button" class="kb-action kb-${action}" data-action="${action}" data-card-id="${id}">${ACTION_LABELS[action]}</button>`)
    .join('');
  return [
    `<article class="kb-card" data-card="${id}" data-column="${escapeHtml(card.column)}"${accent ? ` style="--project-accent:${escapeHtml(accent)}"` : ''}>`,
    `<header class="kb-head">${avatar(card, projects)}<span class="kb-title">${escapeHtml(card.title)}</span></header>`,
    '<div class="kb-meta">',
    card.outside ? '<span class="kb-badge kb-outside">fora do Vizor</span>' : '',
    card.thin ? '<span class="kb-badge kb-thin">pouca informação</span>' : '',
    card.planProgress ? `<span class="kb-plan">${escapeHtml(card.planProgress)}</span>` : '',
    card.branch ? `<span class="kb-branch">${escapeHtml(card.branch)}</span>` : '',
    card.since ? `<span class="kb-since">${escapeHtml(agoLabel(card.since, now))}</span>` : '',
    '</div>',
    card.question ? `<p class="kb-question">${escapeHtml(card.question)}</p>` : '',
    card.guardAsk ? renderGuardCard(card.guardAsk) : '',
    `<div class="kb-actions">${buttons}</div>`,
    '</article>',
  ].join('');
}

// filter: { project: root | null, needsMe: bool }
function passes(card, filter) {
  if (filter?.needsMe && card.column !== 'waiting') return false;
  if (filter?.project && card.projectRoot !== filter.project) return false;
  return true;
}

export function renderKanban(cards, { filter = {}, projects = {}, now = Date.now() } = {}) {
  const shown = (cards ?? []).filter((card) => passes(card, filter));
  if (!shown.length) {
    return '<div class="kb-empty empty-state">nenhum agente rodando</div>';
  }
  const columns = ORDER.map((column) => {
    const inColumn = shown.filter((card) => card.column === column);
    return [
      `<section class="kb-column" data-column="${column}">`,
      `<header class="kb-column-head"><span class="kb-column-title">${COLUMN_TITLES[column]}</span><span class="kb-count">${inColumn.length}</span></header>`,
      `<div class="kb-cards">${inColumn.map((card) => renderCard(card, projects, now)).join('')}</div>`,
      '</section>',
    ].join('');
  });
  return `<div class="kb-board">${columns.join('')}</div>`;
}

// Loading placeholder: shape-only rows.
export function skeleton(kind = 'list', rows = 3) {
  const row = '<div class="skeleton-row"><span class="skeleton-bar"></span><span class="skeleton-bar short"></span></div>';
  return `<div class="skeleton skeleton-${escapeHtml(kind)}" aria-hidden="true">${row.repeat(Math.max(0, rows))}</div>`;
}
