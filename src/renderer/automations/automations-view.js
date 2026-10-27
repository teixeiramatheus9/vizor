// Pure HTML builders and form logic for the Automações tab. No DOM access:
// everything that came from an automação, a project or a report goes through
// escapeHtml (reports through renderSafeMarkdown). The "quando" rules come
// from the main schedule module, which has no node imports.
import { escapeHtml } from '../workspace-view.js';
import { skeleton } from '../shared/skeleton.js';
import { renderSafeMarkdown } from '../shared/safe-markdown.js';
import { monogramColor, monogramOf } from '../project-accent.js';
import { parseWhen } from '../../main/automations/schedule.js';

export const EMPTY_TEXT = 'nenhuma automação ainda: crie uma pra rodar um pedido no horário';
export const GUARD_OFF_REASON = 'a trava está desligada; ligue-a nas configurações pra editar';

export const LEVELS = [
  { id: 'read', label: 'Ler e relatar', badge: 'lê', hint: 'só lê arquivos, git e gh de leitura, e roda os testes e o lint; não edita nada' },
  { id: 'worktree', label: 'Editar numa worktree', badge: 'worktree', hint: 'edita e commita numa worktree só dela, sem tocar no seu checkout; nunca push' },
  { id: 'project', label: 'Agir no projeto', badge: 'age', hint: 'edita e commita no seu checkout; pode publicar no GitHub (comentar, abrir issue/PR); nunca push nem merge' },
];
export const MODELS = [{ id: 'haiku', label: 'Haiku (barato)' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus (caro)' }];
export const WEEK_DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const PRESETS = [
  { label: 'a cada 30 min', fields: { whenKind: 'every', everyN: '30', everyUnit: 'min' } },
  { label: 'todo dia às 9h', fields: { whenKind: 'daily', at: '09:00' } },
  { label: 'dias úteis às 9h', fields: { whenKind: 'weekdays', at: '09:00' } },
];
const SKILL_WARNING = 'vai pro repositório se você commitar';

const levelOf = (id) => LEVELS.find((level) => level.id === id) ?? LEVELS[0];
const pad = (n) => String(n).padStart(2, '0');

export const money = (usd) => `US$ ${(Number(usd) || 0).toFixed(2).replace('.', ',')}`;

// "há 4 min" from a past timestamp.
export function agoLabel(since, now) {
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

// "14:00" today, "amanhã 14:00", else "28/10 14:00".
export function nextLabel(at, now) {
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const diff = Math.round((day(at) - day(now)) / 86400000);
  if (diff === 0) return clock;
  if (diff === 1) return `amanhã ${clock}`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${clock}`;
}

// A running clock: "3 min 05 s".
export function elapsedLabel(since, now) {
  const seconds = Math.floor(Math.max(0, now - since) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
}

// The history's status text. A blocked run is "ok, com passos barrados" when
// it otherwise ended fine (the service's reason is then the denial count).
export function runStatusLabel(entry) {
  let text;
  switch (entry?.status) {
    case 'ok': text = 'ok'; break;
    case 'failed': text = 'falhou'; break;
    case 'over-cap': text = 'passou do teto'; break;
    case 'timeout': text = 'passou do tempo'; break;
    case 'cancelled': text = 'cancelada'; break;
    case 'blocked': text = !entry.reason || /^A trava barrou/.test(entry.reason) ? 'ok, com passos barrados' : 'barrada pela trava'; break;
    default: text = String(entry?.status ?? '?');
  }
  return entry?.late ? `${text} (atrasada)` : text;
}
const statusTone = (entry) => (entry?.status === 'ok' ? 'ok' : entry?.status === 'blocked' && runStatusLabel(entry).startsWith('ok') ? 'ok' : entry?.status === 'cancelled' ? 'neutral' : 'bad');

// The worktree an automação of the second level edits (see worktree.js).
export function worktreeOf(a) {
  const root = String(a?.projectRoot ?? '').replace(/\/+$/, '');
  return root ? `${root}-auto-${a.slug}` : null;
}

// --- the form ---------------------------------------------------------------

export function blankForm(projects = {}) {
  const root = Object.keys(projects)[0] ?? '';
  return {
    id: null, name: '', prompt: '', original: null, projectRoot: root,
    whenKind: 'daily', everyN: '1', everyUnit: 'h', at: '09:00', days: [1, 2, 3, 4, 5],
    level: 'read', model: 'sonnet', capUsd: '1', timeoutMin: '15', missed: 'run', skillScope: 'personal',
  };
}

export function formFromAutomation(a) {
  const form = blankForm();
  const when = a.when ?? {};
  Object.assign(form, {
    id: a.id, name: a.name, prompt: a.prompt, projectRoot: a.projectRoot, level: a.level, model: a.model,
    capUsd: String(a.capUsd), timeoutMin: String(a.timeoutMin), missed: a.missed, skillScope: a.skillScope, whenKind: when.kind,
  });
  if (when.kind === 'every') {
    const hours = when.minutes >= 60 && when.minutes % 60 === 0;
    Object.assign(form, { everyN: String(hours ? when.minutes / 60 : when.minutes), everyUnit: hours ? 'h' : 'min' });
  } else {
    form.at = when.at ?? '09:00';
    if (when.kind === 'days') form.days = [...when.days];
  }
  return form;
}

function whenOf(form) {
  if (form.whenKind === 'every') {
    const n = Number(String(form.everyN).replace(',', '.'));
    return { kind: 'every', minutes: form.everyUnit === 'h' ? n * 60 : n };
  }
  if (form.whenKind === 'days') return { kind: 'days', days: form.days, at: form.at };
  return { kind: form.whenKind, at: form.at };
}

const num = (text) => (String(text ?? '').trim() === '' ? NaN : Number(String(text).replace(',', '.')));

// → { errors: { field: message }, payload: object|null }. Mirrors what the
// store enforces, so the answer shows while typing instead of after saving.
export function validateForm(form, { guardEnabled = true, projects = {} } = {}) {
  const errors = {};
  if (!String(form.name ?? '').trim()) errors.name = 'Dê um nome à automação.';
  if (!String(form.prompt ?? '').trim()) errors.prompt = 'Escreva o que a automação deve fazer.';
  if (!form.projectRoot || (form.id == null && Object.keys(projects).length && !(form.projectRoot in projects))) errors.projectRoot = 'Escolha o projeto.';
  const when = whenOf(form);
  const parsed = parseWhen(when);
  if (parsed.error) errors.when = parsed.error;
  const capUsd = num(form.capUsd);
  if (!(capUsd >= 0.05 && capUsd <= 20)) errors.capUsd = 'O teto deve ficar entre US$ 0,05 e US$ 20.';
  const timeoutMin = num(form.timeoutMin);
  if (!(Number.isInteger(timeoutMin) && timeoutMin >= 1 && timeoutMin <= 60)) errors.timeoutMin = 'O tempo limite deve ficar entre 1 e 60 min.';
  if (form.level !== 'read' && !guardEnabled) errors.level = GUARD_OFF_REASON;
  if (Object.keys(errors).length) return { errors, payload: null };
  const payload = {
    name: form.name.trim(), prompt: form.prompt, projectRoot: form.projectRoot, when: parsed,
    level: form.level, model: form.model, capUsd, timeoutMin, missed: form.missed, skillScope: form.skillScope,
  };
  if (form.id != null) payload.id = form.id;
  return { errors, payload };
}

// key: the validateForm error this field shows (data-au-error), updated live by the controller.
const field = (key, label, control, error, hint) =>
  `<label class="au-field${error ? ' invalid' : ''}"><span class="au-label">${escapeHtml(label)}</span>${control}${hint ? `<span class="au-hint">${escapeHtml(hint)}</span>` : ''}<span class="au-error" data-au-error="${key}">${error ? escapeHtml(error) : ''}</span></label>`;

const options = (list, selected, valueOf = (item) => item.id, labelOf = (item) => item.label) =>
  list.map((item) => `<option value="${escapeHtml(valueOf(item))}"${valueOf(item) === selected ? ' selected' : ''}>${escapeHtml(labelOf(item))}</option>`).join('');

// ui: { improving, improveError, saveError }
export function renderForm(form, { projects = {}, guardEnabled = true, readError = null, ui = {} } = {}) {
  const { errors } = validateForm(form, { guardEnabled, projects });
  const roots = Object.keys(projects);
  const projectList = form.projectRoot && !roots.includes(form.projectRoot) ? [form.projectRoot, ...roots] : roots;
  const nameOf = (root) => projects[root]?.name ?? String(root).split('/').filter(Boolean).pop() ?? root;
  const when = [
    `<div class="au-presets">${PRESETS.map((preset, index) => `<button type="button" class="au-chip" data-au-preset="${index}">${escapeHtml(preset.label)}</button>`).join('')}</div>`,
    '<div class="au-when">',
    `<select class="au-input" data-au-field="whenKind" aria-label="Tipo de horário">${options([{ id: 'every', label: 'a cada' }, { id: 'daily', label: 'todo dia às' }, { id: 'weekdays', label: 'dias úteis às' }, { id: 'days', label: 'nos dias escolhidos às' }], form.whenKind)}</select>`,
    form.whenKind === 'every'
      ? `<input class="au-input au-narrow" data-au-field="everyN" value="${escapeHtml(form.everyN)}" inputmode="numeric" aria-label="Intervalo" /><select class="au-input" data-au-field="everyUnit" aria-label="Unidade">${options([{ id: 'min', label: 'minutos' }, { id: 'h', label: 'horas' }], form.everyUnit)}</select>`
      : `<input class="au-input au-narrow" data-au-field="at" type="time" value="${escapeHtml(form.at)}" aria-label="Horário" />`,
    '</div>',
    form.whenKind === 'days'
      ? `<div class="au-days">${WEEK_DAYS.map((name, day) => `<label class="au-day"><input type="checkbox" data-au-day="${day}"${form.days.includes(day) ? ' checked' : ''} />${escapeHtml(name)}</label>`).join('')}</div>`
      : '',
  ].join('');
  const levels = LEVELS.map((level) => {
    const blocked = level.id !== 'read' && !guardEnabled;
    return `<label class="au-level${form.level === level.id ? ' on' : ''}${blocked ? ' disabled' : ''}"><input type="radio" name="au-level" data-au-field="level" value="${level.id}"${form.level === level.id ? ' checked' : ''}${blocked ? ' disabled' : ''} /><span class="au-level-name">${escapeHtml(level.label)}</span><span class="au-hint">${escapeHtml(level.hint)}</span>${blocked ? `<span class="au-error">${escapeHtml(GUARD_OFF_REASON)}</span>` : ''}</label>`;
  }).join('');
  const improved = form.original != null;
  return [
    `<form class="au-form" data-au-form novalidate><h3>${form.id ? 'Editar automação' : 'Nova automação'}</h3>`,
    readError ? `<div class="au-banner" role="alert">${escapeHtml(readError)}</div>` : '',
    field('name', 'Nome', `<input class="au-input" data-au-field="name" value="${escapeHtml(form.name)}" maxlength="80" autocomplete="off" spellcheck="false" />`, errors.name),
    field('prompt', 'O pedido', `<textarea class="au-input au-prompt" data-au-field="prompt" rows="7" spellcheck="false">${escapeHtml(form.prompt)}</textarea>`, errors.prompt),
    '<div class="au-row">',
    `<button type="button" class="au-btn" data-au-action="improve"${ui.improving ? ' disabled' : ''}>${ui.improving ? 'melhorando…' : 'melhorar o pedido'}</button>`,
    improved ? '<button type="button" class="au-btn" data-au-action="undo-improve">voltar ao meu texto</button><span class="au-hint">o gerente reescreveu o pedido: confira e edite antes de salvar</span>' : '',
    ui.improveError ? `<span class="au-error" role="alert">${escapeHtml(ui.improveError)}</span>` : '',
    '</div>',
    field('projectRoot', 'Projeto', `<select class="au-input" data-au-field="projectRoot">${projectList.length ? options(projectList.map((root) => ({ id: root, label: nameOf(root) })), form.projectRoot) : '<option value="">(nenhum projeto)</option>'}</select>`, errors.projectRoot),
    `<div class="au-field${errors.when ? ' invalid' : ''}"><span class="au-label">Quando</span>${when}<span class="au-error" data-au-error="when">${errors.when ? escapeHtml(errors.when) : ''}</span></div>`,
    `<div class="au-field"><span class="au-label">Permissão</span><div class="au-levels">${levels}</div></div>`,
    '<div class="au-grid">',
    field('model', 'Modelo', `<select class="au-input" data-au-field="model">${options(MODELS, form.model)}</select>`),
    field('capUsd', 'Teto por execução (US$)', `<input class="au-input au-narrow" data-au-field="capUsd" value="${escapeHtml(form.capUsd)}" inputmode="decimal" />`, errors.capUsd),
    field('timeoutMin', 'Tempo limite (min)', `<input class="au-input au-narrow" data-au-field="timeoutMin" value="${escapeHtml(form.timeoutMin)}" inputmode="numeric" />`, errors.timeoutMin),
    field('missed', 'Se perder o horário', `<select class="au-input" data-au-field="missed">${options([{ id: 'run', label: 'rodar ao abrir' }, { id: 'skip', label: 'pular' }], form.missed)}</select>`),
    '</div>',
    field('skillScope', 'Onde mora a skill', `<select class="au-input" data-au-field="skillScope">${options([{ id: 'personal', label: 'pessoal (~/.claude)' }, { id: 'project', label: 'do projeto' }], form.skillScope)}</select>`, null, form.skillScope === 'project' ? SKILL_WARNING : ''),
    ui.saveError ? `<span class="au-error" role="alert">${escapeHtml(ui.saveError)}</span>` : '',
    '<div class="au-row au-footer">',
    `<button type="submit" class="au-btn primary" data-au-action="save"${Object.keys(errors).length || readError ? ' disabled' : ''}>Salvar</button>`,
    '<button type="button" class="au-btn" data-au-action="close-side">Cancelar</button>',
    '</div></form>',
  ].join('');
}

// --- the list ---------------------------------------------------------------

function avatar(root, projects) {
  const project = projects?.[root];
  const name = project?.name ?? String(root ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (String(project?.uri ?? '').startsWith('data:image/')) return `<img class="au-avatar" src="${escapeHtml(project.uri)}" alt="" width="22" height="22" />`;
  return `<span class="au-avatar mono" style="background:${escapeHtml(project?.accent ?? monogramColor(name))}" aria-hidden="true">${escapeHtml(monogramOf(name))}</span>`;
}

// The item's state, in order of what matters to the user.
export function stateOf(a) {
  if (a.running) return { id: 'running', late: Boolean(a.running.late) };
  if (a.queued) return { id: 'queued' };
  if (a.blockedUntilConfirm) return { id: 'blocked' };
  if (a.paused) return { id: 'paused' };
  return { id: 'idle' };
}

function renderItem(a, { projects, now, ui, readError, selected }) {
  const id = escapeHtml(a.id);
  const state = stateOf(a);
  const level = levelOf(a.level);
  const button = (action, label, extra = '') => `<button type="button" class="au-btn" data-au-action="${action}" data-id="${id}"${extra}>${label}</button>`;
  const chip = {
    running: `<span class="au-state running">rodando há ${escapeHtml(elapsedLabel(a.running?.startedAt ?? now, now))}${state.late ? ' · atrasada' : ''}</span>`,
    queued: '<span class="au-state queued">na fila</span>',
    blocked: '<span class="au-state blocked">bloqueada: passou do teto ou do tempo</span>',
    paused: '<span class="au-state paused">pausada</span>',
    idle: '',
  }[state.id];
  const last = a.last
    ? `<span class="au-last ${statusTone(a.last)}">${statusTone(a.last) === 'ok' ? '✓' : a.last.status === 'cancelled' ? '–' : '✗'} ${escapeHtml(runStatusLabel(a.last))} ${escapeHtml(a.last.at ? agoLabel(Date.parse(a.last.at), now) : '')}</span>`
    : '<span class="au-last neutral">nunca rodou</span>';
  const next = a.next != null ? `<span class="au-next">próxima: ${escapeHtml(nextLabel(a.next, now))}</span>` : '';
  const busy = state.id === 'running' || state.id === 'queued';
  const actions = [
    busy ? button('cancel', 'Cancelar') : button('run', 'Rodar agora', state.id === 'blocked' ? ' disabled title="confirme antes de rodar de novo"' : ''),
    state.id === 'blocked' ? button('confirm', 'Confirmar') : '',
    button('pause', a.paused ? 'Retomar' : 'Pausar', busy ? ' disabled' : ''),
    button('edit', 'Editar', busy ? ' disabled' : ''),
    button('history', 'Histórico'),
    ui.deleting === a.id ? '' : button('delete', 'Apagar', busy || readError ? ' disabled' : ''),
  ].join('');
  const confirmDelete = ui.deleting === a.id
    ? `<div class="au-confirm" data-id="${id}"><span>Apagar “${escapeHtml(a.name)}”?</span>
      <label><input type="checkbox" data-au-drop="skill"${ui.dropSkill ? ' checked' : ''} /> apagar a skill também</label>
      ${a.level === 'worktree' ? `<label><input type="checkbox" data-au-drop="worktree"${ui.dropWorktree ? ' checked' : ''} /> remover a worktree</label>` : ''}
      ${button('delete-confirm', 'Apagar')}${button('delete-cancel', 'Não')}</div>`
    : '';
  const projectName = projects?.[a.projectRoot]?.name ?? String(a.projectRoot ?? '').split('/').filter(Boolean).pop() ?? '';
  return [
    `<article class="au-item${selected ? ' selected' : ''}" data-automation="${id}" data-state="${state.id}">`,
    `<header class="au-head">${avatar(a.projectRoot, projects)}<span class="au-name">${escapeHtml(a.name)}</span><span class="au-badge level-${escapeHtml(level.id)}" title="${escapeHtml(level.hint)}">${escapeHtml(level.badge)}</span>${chip}</header>`,
    `<div class="au-meta"><span class="au-project">${escapeHtml(projectName)}</span><span class="au-when-text">${escapeHtml(a.describe ?? '')}</span>${next}${last}</div>`,
    `<div class="au-actions">${actions}</div>`,
    ui.error?.id === a.id ? `<span class="au-error" role="alert">${escapeHtml(ui.error.text)}</span>` : '',
    confirmDelete,
    '</article>',
  ].join('');
}

export function renderList(list, { projects = {}, now = Date.now(), ui = {}, readError = null, selectedId = null, loading = false } = {}) {
  if (loading) return skeleton('list', 4);
  if (!list.length) return `<div class="au-empty empty-state">${escapeHtml(EMPTY_TEXT)}</div>`;
  return list.map((a) => renderItem(a, { projects, now, ui, readError, selected: a.id === selectedId })).join('');
}

// budget: { spent, cap, paused }; ui.capEditing: the "subir teto" field is open.
export function renderTop({ budget = null, readError = null, ui = {} } = {}) {
  const parts = [];
  if (budget) {
    const cap = (Number(budget.cap) || 0).toFixed(2).replace('.', ',');
    parts.push(`<span class="au-budget${budget.paused ? ' over' : ''}">hoje: ${escapeHtml(money(budget.spent))} de ${escapeHtml(cap)}</span>`);
    if (ui.capEditing) {
      parts.push(`<form class="au-cap" data-au-cap><input class="au-input au-narrow" data-au-cap-input value="${escapeHtml(String(budget.cap).replace('.', ','))}" inputmode="decimal" aria-label="Teto do dia (US$)" /><button type="submit" class="au-btn primary">OK</button><button type="button" class="au-btn" data-au-action="cap-cancel">Cancelar</button>${ui.capError ? `<span class="au-error" role="alert">${escapeHtml(ui.capError)}</span>` : ''}</form>`);
    } else {
      parts.push('<button type="button" class="au-link" data-au-action="cap-edit">subir teto</button>');
    }
    if (budget.paused) parts.push('<span class="au-state blocked">pausadas até amanhã ou até subir o teto</span>');
  }
  parts.push('<button type="button" class="au-btn primary au-new" data-au-action="new">nova automação</button>');
  return [readError ? `<div class="au-banner" role="alert">${escapeHtml(readError)}</div>` : '', `<div class="au-bar">${parts.join('')}</div>`].join('');
}

// --- the side panel: history and report --------------------------------------

// runs: newest first; report: { file, text } | null; loading: the history is being read.
export function renderHistory({ automation, runs = null, report = null, loading = false, now = Date.now() } = {}) {
  if (!automation) return '';
  const head = `<header class="au-side-head"><h3>${escapeHtml(automation.name)}</h3><button type="button" class="au-btn" data-au-action="close-side">Fechar</button></header>`;
  if (loading || runs === null) return `${head}${skeleton('list', 3)}`;
  if (!runs.length) return `${head}<div class="au-empty empty-state">ainda não rodou</div>`;
  const rows = runs.map((run) => {
    const on = report?.file === run.report;
    return `<li><button type="button" class="au-run${on ? ' on' : ''} ${statusTone(run)}" data-au-run="${escapeHtml(run.report ?? '')}" data-id="${escapeHtml(automation.id)}"><span class="au-run-status">${escapeHtml(runStatusLabel(run))}</span><span class="au-run-when">${escapeHtml(run.at ? agoLabel(Date.parse(run.at), now) : '')}</span><span class="au-run-cost">${escapeHtml(money(run.costUsd))} · ${escapeHtml(Math.round((run.durationMs ?? 0) / 1000))} s</span></button></li>`;
  }).join('');
  const current = runs.find((run) => run.report === report?.file);
  const review = automation.level === 'worktree' && current?.branch
    ? `<button type="button" class="au-btn" data-au-action="review" data-id="${escapeHtml(automation.id)}">abrir na revisão</button><span class="au-hint">branch ${escapeHtml(current.branch)}</span>`
    : '';
  const body = report
    ? `<div class="au-report-bar">${review}</div><div class="au-report gh-markdown">${report.text == null ? '<p>não consegui ler este relatório</p>' : renderSafeMarkdown(report.text)}</div>`
    : '<div class="au-empty empty-state">escolha uma execução pra ler o relatório</div>';
  return `${head}<div class="au-history"><ul class="au-runs">${rows}</ul><div class="au-report-pane">${body}</div></div>`;
}

export function renderSideEmpty() {
  return '<div class="au-empty empty-state">escolha “Histórico” numa automação pra ler os relatórios, ou crie uma nova</div>';
}
