// Pure HTML builder for the Agents tab's kanban. No DOM access; everything
// from a session or a project goes through escapeHtml.
import { escapeHtml } from '../workspace-view.js';
import { skeleton } from '../shared/skeleton.js';
import { renderGuardCard } from '../guard-card.js';
import { monogramColor, monogramOf } from '../project-accent.js';

export const COLUMN_TITLES = {
  waiting: 'Esperando você',
  working: 'Trabalhando',
  done: 'Terminou',
  idle: 'Ociosa',
  failed: 'Falhou',
};
// Chats whose folder is no workspace project (the "outros" chip).
export const OTHER_PROJECTS = '__other__';
const ORDER = ['waiting', 'working', 'done', 'idle', 'failed'];

const ACTION_LABELS = {
  focus: 'Abrir',
  answer: 'Responder',
  approve: 'Aprovar',
  'approve-plan': 'Aprovar plano',
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

// ui: { answering: id|null, confirming: id|null, error: { id, text }|null } — the
// inline reply box and the interrupt confirmation, both owned by the controller.
function renderCard(card, projects, now, ui = {}) {
  const id = escapeHtml(card.id);
  const accent = projects?.[card.avatarKey]?.accent;
  const button = (action, label = ACTION_LABELS[action]) =>
    `<button type="button" class="kb-action kb-${action}" data-action="${action}" data-card-id="${id}">${label}</button>`;
  const buttons = (card.actions ?? [])
    .filter((action) => Object.hasOwn(ACTION_LABELS, action))
    .map((action) => {
      if (action === 'interrupt' && ui.confirming === card.id)
        return `<span class="kb-confirm">Interromper?</span>${button('interrupt-confirm', 'Sim')}${button('cancel', 'Não')}`;
      return button(action);
    })
    .join('');
  const reply =
    ui.answering === card.id
      ? `<form class="kb-reply" data-card-id="${id}"><input class="kb-reply-input" name="text" maxlength="2000" placeholder="Sua resposta…" autocomplete="off" spellcheck="false" /><button type="submit" class="kb-action kb-send">Enviar</button>${button('cancel', 'Cancelar')}${
          ui.error?.id === card.id ? `<span class="kb-error" role="alert">${escapeHtml(ui.error.text)}</span>` : ''
        }</form>`
      : '';
  return [
    `<article class="kb-card" data-card="${id}" data-column="${escapeHtml(card.column)}"${accent ? ` style="--project-accent:${escapeHtml(accent)}"` : ''}>`,
    `<header class="kb-head">${avatar(card, projects)}<span class="kb-title">${escapeHtml(card.title)}</span></header>`,
    '<div class="kb-meta">',
    card.badge ? `<span class="kb-badge kb-automation">${escapeHtml(card.badge)}</span>` : '',
    card.late ? '<span class="kb-badge kb-thin">atrasada</span>' : '',
    card.outside ? '<span class="kb-badge kb-outside">fora do Vizor</span>' : '',
    card.thin ? '<span class="kb-badge kb-thin">pouca informação</span>' : '',
    card.planProgress ? `<span class="kb-plan">${escapeHtml(card.planProgress)}</span>` : '',
    card.branch ? `<span class="kb-branch">${escapeHtml(card.branch)}</span>` : '',
    card.share > 0 ? `<span class="kb-share" title="Parte estimada da janela de 5h">≈${Math.round(card.share)}% das 5h</span>` : '',
    card.since ? `<span class="kb-since">${escapeHtml(agoLabel(card.since, now))}</span>` : '',
    '</div>',
    card.question ? `<p class="kb-question">${escapeHtml(card.question)}</p>` : '',
    card.guardAsk ? renderGuardCard(card.guardAsk) : '',
    reply,
    `<div class="kb-actions">${buttons}</div>`,
    ui.error?.id === card.id && ui.answering !== card.id ? `<span class="kb-error" role="alert">${escapeHtml(ui.error.text)}</span>` : '',
    '</article>',
  ].join('');
}

// filter: { project: root | null, needsMe: bool }
function passes(card, filter) {
  if (filter?.needsMe && card.column !== 'waiting') return false;
  if (filter?.project === OTHER_PROJECTS) return card.projectRoot === null;
  if (filter?.project && card.projectRoot !== filter.project) return false;
  return true;
}

export function renderKanban(cards, { filter = {}, projects = {}, now = Date.now(), ui = {}, loading = false } = {}) {
  if (loading) return skeleton('board', 4);
  const shown = (cards ?? []).filter((card) => passes(card, filter));
  if (!shown.length) {
    return '<div class="kb-empty empty-state">nenhum agente rodando</div>';
  }
  const columns = ORDER.map((column) => {
    const inColumn = shown.filter((card) => card.column === column);
    return [
      `<section class="kb-column" data-column="${column}">`,
      `<header class="kb-column-head"><span class="kb-column-title">${COLUMN_TITLES[column]}</span><span class="kb-count">${inColumn.length}</span></header>`,
      `<div class="kb-cards">${inColumn.map((card) => renderCard(card, projects, now, ui)).join('')}</div>`,
      '</section>',
    ].join('');
  });
  return `<div class="kb-board">${columns.join('')}</div>`;
}

// The filter strip above the board: one chip per project (with its avatar),
// "outros" for chats outside every project, and "só o que precisa de mim".
// projectList: [{ root, name, uri, accent }]
export function renderFilters(projectList, { filter = {}, hasOthers = false } = {}) {
  const chip = (attrs, on, inner) => `<button type="button" class="kb-chip${on ? ' on' : ''}" aria-pressed="${on}" ${attrs}>${inner}</button>`;
  const chips = [chip('data-kb-filter="project" data-value=""', !filter.project, 'Todos')];
  for (const project of projectList ?? []) {
    const mark = avatar({ avatarKey: project.root }, { [project.root]: project });
    chips.push(chip(`data-kb-filter="project" data-value="${escapeHtml(project.root)}"`, filter.project === project.root, `${mark}<span>${escapeHtml(project.name)}</span>`));
  }
  if (hasOthers) chips.push(chip(`data-kb-filter="project" data-value="${OTHER_PROJECTS}"`, filter.project === OTHER_PROJECTS, 'Outros'));
  const needs = chip('data-kb-filter="needsMe"', Boolean(filter.needsMe), 'Só o que precisa de mim');
  return `<div class="kb-filters"><div class="kb-chips">${chips.join('')}</div>${needs}</div>`;
}
