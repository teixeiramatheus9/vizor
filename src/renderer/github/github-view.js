// Pure HTML builder for the GitHub tab: project picker, Issues and PRs lists,
// filters and the body panel. Everything from GitHub goes through escapeHtml.
import { escapeHtml } from '../workspace-view.js';
import { monogramColor, monogramOf } from '../project-accent.js';
import { renderSafeMarkdown } from '../shared/safe-markdown.js';
import { agoLabel } from '../agents/kanban-view.js';

const HEX = /^[0-9a-f]{6}$/i;

// GitHub label colours are arbitrary: pick black or white text by luminance.
export function labelStyle(color) {
  const text = String(color ?? '');
  const hex = HEX.test(text) ? text : '8b949e';
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return `background:#${hex};color:${luminance > 0.179 ? '#111' : '#fff'}`;
}

const label = (l) => `<span class="gh-label" style="${labelStyle(l.color)}">${escapeHtml(l.name)}</span>`;

const CHECKS = { ok: ['✓', 'checks passando'], fail: ['✗', 'checks falhando'], running: ['…', 'checks rodando'] };
const REVIEWS = {
  APPROVED: 'aprovada',
  CHANGES_REQUESTED: 'pedindo mudanças',
  REVIEW_REQUIRED: 'esperando revisão',
};

// chats: issue number -> { state } of the Vizor chat linked to it.
function chatBadge(chats, number) {
  const chat = chats?.[number];
  return chat ? `<span class="gh-chat" data-chat-state="${escapeHtml(chat.state ?? '')}">chat${chat.state ? `: ${escapeHtml(chat.state)}` : ''}</span>` : '';
}

function renderIssue(issue, chats, selected) {
  const number = escapeHtml(issue.number);
  const on = selected?.kind === 'issue' && Number(selected.number) === Number(issue.number);
  const assignees = (issue.assignees ?? []).map((a) => `<span class="gh-assignee">@${escapeHtml(a.login)}</span>`).join('');
  return [
    `<li class="gh-item${on ? ' selected' : ''}" data-gh-kind="issue" data-gh-number="${number}">`,
    `<div class="gh-line"><span class="gh-number">#${number}</span><span class="gh-title">${escapeHtml(issue.title)}</span>${chatBadge(chats, issue.number)}</div>`,
    `<div class="gh-meta">${(issue.labels ?? []).map(label).join('')}${assignees}</div>`,
    `<div class="gh-actions"><button type="button" class="gh-action" data-action="pull" data-gh-number="${number}">Puxar</button><button type="button" class="gh-action" data-action="open" data-gh-kind="issue" data-gh-number="${number}">Abrir no GitHub</button></div>`,
    '</li>',
  ].join('');
}

function renderPr(pr, selected) {
  const number = escapeHtml(pr.number);
  const on = selected?.kind === 'pr' && Number(selected.number) === Number(pr.number);
  const checks = Object.hasOwn(CHECKS, pr.checks) ? CHECKS[pr.checks] : null;
  const review = Object.hasOwn(REVIEWS, pr.reviewDecision) ? REVIEWS[pr.reviewDecision] : null;
  return [
    `<li class="gh-item${on ? ' selected' : ''}" data-gh-kind="pr" data-gh-number="${number}">`,
    `<div class="gh-line"><span class="gh-number">#${number}</span><span class="gh-title">${escapeHtml(pr.title)}</span>`,
    `<span class="gh-draft">${pr.isDraft ? 'rascunho' : 'pronta'}</span>`,
    checks ? `<span class="gh-checks gh-checks-${escapeHtml(pr.checks)}" title="${checks[1]}">${checks[0]}</span>` : '',
    '</div>',
    `<div class="gh-meta">${pr.author?.login ? `<span class="gh-author">@${escapeHtml(pr.author.login)}</span>` : ''}${
      review ? `<span class="gh-review">${review}</span>` : ''
    }${pr.headRefName ? `<span class="gh-branch">${escapeHtml(pr.headRefName)}</span>` : ''}${(pr.labels ?? []).map(label).join('')}</div>`,
    `<div class="gh-actions"><button type="button" class="gh-action" data-action="review" data-gh-number="${number}">Revisar</button><button type="button" class="gh-action" data-action="open" data-gh-kind="pr" data-gh-number="${number}">Abrir no GitHub</button></div>`,
    '</li>',
  ].join('');
}

const norm = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// filter: { mine, unassigned, label, text }
function filterIssues(issues, filter, mineNumbers) {
  const text = norm(filter?.text);
  return issues.filter((issue) => {
    if (filter?.mine && !mineNumbers.has(issue.number)) return false;
    if (filter?.unassigned && (issue.assignees ?? []).length) return false;
    if (filter?.label && !(issue.labels ?? []).some((l) => l.name === filter.label)) return false;
    return !text || norm(`${issue.number} ${issue.title}`).includes(text);
  });
}

function filterPrs(prs, filter) {
  const text = norm(filter?.text);
  return prs.filter((pr) => {
    if (filter?.label && !(pr.labels ?? []).some((l) => l.name === filter.label)) return false;
    return !text || norm(`${pr.number} ${pr.title}`).includes(text);
  });
}

function listError(what, result) {
  return `<div class="gh-error">não deu pra ler ${what}: ${escapeHtml(result.error)}</div>`;
}

function section(title, result, render, emptyText) {
  let inner;
  if (result && !Array.isArray(result) && result.error != null) inner = listError(title === 'Issues' ? 'as issues' : 'as PRs', result);
  else {
    const items = Array.isArray(result) ? result : [];
    inner = items.length ? `<ul class="gh-list">${items.map(render).join('')}</ul>` : `<div class="empty-state">${emptyText}</div>`;
  }
  const count = Array.isArray(result) ? `<span class="gh-count">${result.length}</span>` : '';
  return `<section class="gh-section" data-gh-section="${title === 'Issues' ? 'issues' : 'prs'}"><header class="gh-section-head"><span>${title}</span>${count}</header>${inner}</section>`;
}

function picker(projects, current) {
  const options = projects
    .map((p) => {
      const art = String(p.uri ?? '').startsWith('data:image/')
        ? `<img class="gh-avatar" src="${escapeHtml(p.uri)}" alt="" width="16" height="16" />`
        : `<span class="gh-avatar mono" style="background:${escapeHtml(p.accent ?? monogramColor(p.name))}" aria-hidden="true">${escapeHtml(monogramOf(p.name))}</span>`;
      return `<button type="button" class="gh-project${p.root === current ? ' selected' : ''}" data-gh-project="${escapeHtml(p.root)}">${art}<span>${escapeHtml(p.name)}</span></button>`;
    })
    .join('');
  return `<div class="gh-picker">${options}</div>`;
}

function filters(filter, issues) {
  const labels = [...new Set((issues ?? []).flatMap((i) => (i.labels ?? []).map((l) => l.name)))].sort();
  const chip = (key, text) => `<button type="button" class="gh-filter${filter?.[key] ? ' on' : ''}" data-gh-filter="${key}" aria-pressed="${Boolean(filter?.[key])}">${text}</button>`;
  return [
    '<div class="gh-filters">',
    chip('mine', 'atribuídas a mim'),
    chip('unassigned', 'sem responsável'),
    `<select class="gh-label-filter" data-gh-filter="label"><option value="">todas as labels</option>${labels
      .map((name) => `<option value="${escapeHtml(name)}"${filter?.label === name ? ' selected' : ''}>${escapeHtml(name)}</option>`)
      .join('')}</select>`,
    `<input type="search" class="gh-search" data-gh-filter="text" placeholder="buscar" value="${escapeHtml(filter?.text ?? '')}" />`,
    '<button type="button" class="gh-refresh" data-action="refresh">atualizar</button>',
    '</div>',
  ].join('');
}

// body: markdown text of the selected item, or null while it loads/unselected.
function bodyPanel(selected, body) {
  if (!selected) return '<aside class="gh-body empty"><div class="empty-state">escolha uma issue ou PR pra ler aqui</div></aside>';
  const inner = body == null ? '<div class="skeleton skeleton-body" aria-hidden="true"><div class="skeleton-row"><span class="skeleton-bar"></span></div></div>' : renderSafeMarkdown(body) || '<div class="empty-state">sem descrição</div>';
  return `<aside class="gh-body"><div class="gh-body-head">#${escapeHtml(selected.number)}</div><div class="gh-markdown">${inner}</div></aside>`;
}

// project: selected root. projects: [{ root, name, repo, uri?, accent? }]
// (only those with a GitHub remote). data: createGithubFetcher().list result.
// selected: { kind, number } | null. chats: issue number -> { state }.
export function renderGithub({ project, projects = [], data, filter = {}, selected = null, body = null, chats = {}, now = Date.now() } = {}) {
  if (!projects.length) return '<div class="gh-empty empty-state">esse projeto não está no GitHub</div>';
  const head = picker(projects, project);
  if (!data) return `<div class="gh-root">${head}<div class="gh-columns">${skeletonLists()}</div></div>`;

  const mineNumbers = new Set(Array.isArray(data.mine) ? data.mine.map((i) => i.number) : []);
  const issues = Array.isArray(data.issues) ? filterIssues(data.issues, filter, mineNumbers) : data.issues;
  const prs = Array.isArray(data.prs) ? filterPrs(data.prs, filter) : data.prs;
  const updated = data.at ? `<span class="gh-updated">atualizado ${escapeHtml(agoLabel(data.at, now))}</span>` : '';
  return [
    '<div class="gh-root">',
    `<div class="gh-top">${head}${updated}</div>`,
    filters(filter, Array.isArray(data.issues) ? data.issues : []),
    '<div class="gh-columns">',
    section('Issues', issues, (issue) => renderIssue(issue, chats, selected), 'nenhuma issue aberta por aqui'),
    section('PRs', prs, (pr) => renderPr(pr, selected), 'nenhuma PR aberta por aqui'),
    bodyPanel(selected, body),
    '</div></div>',
  ].join('');
}

function skeletonLists() {
  const row = '<div class="skeleton-row"><span class="skeleton-bar"></span><span class="skeleton-bar short"></span></div>';
  return `<div class="skeleton skeleton-list" aria-hidden="true">${row.repeat(4)}</div>`;
}
