// Pure HTML builders for the workspace window: no DOM access, so vitest can
// run them and the renderer only swaps innerHTML. Everything interpolated goes
// through escapeHtml — session names and paths come from the user's disk.

import { needsYou } from '../main/session-status.js';
import { monogramColor, monogramOf } from './project-accent.js';

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const svg = (body) =>
  `<svg class="icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// Monochrome on purpose: state is told by shape, colour only by the theme.
export const ICONS = {
  working: svg('<path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" class="spin"/>'),
  waiting: svg('<circle cx="6" cy="6" r="4.5"/><path d="M5 4.2v3.6M7 4.2v3.6"/>'),
  permission: svg('<rect x="2.5" y="5.5" width="7" height="5" rx="1"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/>'),
  done: svg('<path d="M2.5 6.3l2.3 2.2 4.7-5"/>'),
  failed: svg('<circle cx="6" cy="6" r="4.5"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2L4.2 7.8"/>'),
  inside: svg('<rect x="1.5" y="2" width="9" height="8" rx="1"/><path d="M3.5 5l1.5 1.2L3.5 7.4M6 7.5h2.5"/>'),
  outside: svg('<path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5L5.5 6.5"/>'),
  branch: svg('<circle cx="3.5" cy="3" r="1.2"/><circle cx="3.5" cy="9" r="1.2"/><circle cx="8.5" cy="4.5" r="1.2"/><path d="M3.5 4.2v3.6M8.5 5.7c0 1.8-2.5 1.6-4.4 2.6"/>'),
  folder: svg('<path d="M1.5 3.5a1 1 0 0 1 1-1h2.2l1 1.2h3.8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z"/>'),
  writing: svg('<path d="M8 2l2 2-5.5 5.5H2.5V7.5z"/>'),
  skipped: svg('<circle cx="6" cy="6" r="4.5"/><path d="M3 9l6-6"/>'),
  command: svg('<path d="M2 3.5l3 2.5-3 2.5M6.5 9h3.5"/>'),
  chevron: svg('<path d="M4.5 3l3 3-3 3"/>'),
  claude: svg('<path d="M2.5 3.5h7v4.5h-4l-2.5 2v-2h-.5z"/>'),
  resume: svg('<path d="M2.5 6a3.5 3.5 0 1 0 1-2.5M2.5 1.8v1.9h1.9"/>'),
  // Inspector width (#153): the frame is the window, the bar the panel, the
  // arrow where its edge goes.
  panelWiden: svg('<rect x="1" y="2" width="10" height="8" rx="1"/><path d="M7.5 2v8M5.5 4.5L4 6l1.5 1.5"/>'),
  panelNarrow: svg('<rect x="1" y="2" width="10" height="8" rx="1"/><path d="M4.5 2v8M6.5 4.5L8 6 6.5 7.5"/>'),
  panelHide: svg('<rect x="1" y="2" width="10" height="8" rx="1"/><path d="M7.5 2v8M8.8 4.5L10.2 6 8.8 7.5"/>'),
  panelShow: svg('<rect x="1" y="2" width="10" height="8" rx="1"/><path d="M7.5 2v8M5 4.5L3.5 6 5 7.5"/>'),
};

export const STATUS_LABEL = {
  permission: 'pedindo permissão',
  waiting: 'esperando você',
  done: 'pronto',
  working: 'rodando',
  failed: 'falhou',
};

function statusKey(session) {
  if (session.needsPermission) return 'permission';
  if (session.status === 'waiting') return needsYou(session) ? 'waiting' : 'done';
  if (session.status === 'done') return 'done';
  // A tombstone (the chat died mid-turn) is not running, whatever its last state said.
  if (session.status === 'failed') return 'failed';
  return 'working';
}

export function statusIcon(session) {
  return ICONS[statusKey(session)];
}

function relativeTo(root, filePath) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath.split('/').pop();
}

function countLabel(file) {
  if (file.added === null || file.removed === null) return '±?';
  return `+${file.added} −${file.removed}`;
}

function renderFile(file, worktreePath) {
  return `<li class="file${file.writing ? ' writing' : ''}" title="${escapeHtml(file.filePath)}">${
    file.writing ? ICONS.writing : ''
  }<span class="file-name">${escapeHtml(relativeTo(worktreePath, file.filePath))}</span><span class="count">${countLabel(file)}</span></li>`;
}

// --- folding (#152): a busy project must not take the whole sidebar ---------
// `folds` holds only the user's own choices (key → open?); everything else
// takes its default: projects and worktrees open, a session's files open up
// to FILES_OPEN_BY_DEFAULT.
const FILES_OPEN_BY_DEFAULT = 3;

function isOpen(folds, key, fallback) {
  return typeof folds?.[key] === 'boolean' ? folds[key] : fallback;
}

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const foldToggle = (key, open, label) =>
  `<button class="fold" data-fold="${escapeHtml(key)}" aria-expanded="${open}" title="${
    open ? 'Recolher' : 'Expandir'
  } ${label}">${ICONS.chevron}</button>`;

// What a folded group hides, in one line: so nothing that needs you disappears.
function foldSummary(sessions) {
  const files = sessions.reduce((sum, session) => sum + session.files.length, 0);
  const alert = sessions.some((session) => ['waiting', 'permission'].includes(statusKey(session)))
    ? '<span class="fold-alert" title="tem sessão esperando você"></span>'
    : '';
  return `<span class="fold-summary">${plural(sessions.length, 'sessão', 'sessões')} · ${plural(
    files,
    'arquivo',
    'arquivos',
  )}</span>${alert}`;
}

// musicians: sessionId → { color, name } while the Maestro is on — the
// orchestra lives in the sidebar as a dot of each músico's color.
function renderSession(session, worktreePath, selectedId, folds, musicians = {}) {
  const key = statusKey(session);
  const where = session.inside ? 'inside' : 'outside';
  const filesOpen = isOpen(folds, `s:${session.id}`, session.files.length <= FILES_OPEN_BY_DEFAULT);
  const filesToggle = session.files.length
    ? `<button class="fold files-fold" data-fold="s:${escapeHtml(session.id)}" aria-expanded="${filesOpen}" title="${
        filesOpen ? 'Esconder' : 'Mostrar'
      } os arquivos">${ICONS.chevron}${plural(session.files.length, 'arquivo', 'arquivos')}</button>`
    : '';
  const files =
    session.files.length && filesOpen
      ? `<ul class="files">${session.files.map((file) => renderFile(file, worktreePath)).join('')}</ul>`
      : '';
  const musician = musicians[session.id];
  const dot = musician
    ? `<span class="session-dot" style="background:${escapeHtml(musician.color)}" title="${escapeHtml(musician.name)}"></span>`
    : '';
  return `<li class="session status-${key}${session.unread ? ' unread' : ''}" data-session="${escapeHtml(session.id)}" aria-selected="${
    session.id === selectedId
  }"><span class="status" title="${STATUS_LABEL[key]}">${ICONS[key]}</span>${dot}<span class="session-name">${escapeHtml(
    session.name,
  )}</span>${filesToggle}<span class="where" title="${session.inside ? 'no Vizor' : 'em outro terminal'}">${ICONS[where]}</span>${files}</li>`;
}

function renderWorktree(worktree, selectedId, selectedWorktree, folds, musicians) {
  const branch = worktree.branch === null ? '(sem branch)' : worktree.branch;
  const open = isOpen(folds, `w:${worktree.path}`, true);
  const sessions = open
    ? `<ul class="sessions">${worktree.sessions
        .map((session) => renderSession(session, worktree.path, selectedId, folds, musicians))
        .join('')}</ul>`
    : '';
  return `<li class="worktree${worktree.prunable ? ' prunable' : ''}" title="${escapeHtml(worktree.path)}"><div class="worktree-head" data-worktree="${escapeHtml(worktree.path)}"${
    worktree.path === selectedWorktree ? ' aria-current="true"' : ''
  }>${foldToggle(`w:${worktree.path}`, open, 'a worktree')}${
    ICONS.branch
  }<span class="branch">${escapeHtml(branch)}</span>${worktree.prunable ? '<span class="tag">(removida)</span>' : ''}${
    open || !worktree.sessions.length ? '' : foldSummary(worktree.sessions)
  }</div>${sessions}</li>`;
}

// avatar: { uri, accent } (main's picture + the renderer's colour pick), or
// nothing: then the project is its monogram on a colour derived from its name.
function renderAvatar(project, avatar) {
  if (avatar?.uri) return `<img class="avatar" src="${escapeHtml(avatar.uri)}" alt="" width="18" height="18" />`;
  return `<span class="avatar mono" style="background:${monogramColor(project.name)}" aria-hidden="true">${escapeHtml(
    monogramOf(project.name),
  )}</span>`;
}

function renderProject(project, selectedId, selectedWorktree, folds, musicians, avatar) {
  const open = isOpen(folds, `p:${project.root}`, true);
  const all = project.worktrees.flatMap((worktree) => worktree.sessions);
  const worktrees = open
    ? `<ul class="worktrees">${project.worktrees
        .map((worktree) => renderWorktree(worktree, selectedId, selectedWorktree, folds, musicians))
        .join('')}</ul>`
    : '';
  const accent = avatar?.accent ?? monogramColor(project.name);
  return `<section class="project${open ? '' : ' folded'}" style="--project-accent:${escapeHtml(accent)}"><header class="project-head" title="${escapeHtml(
    project.root,
  )}">${foldToggle(`p:${project.root}`, open, 'o projeto')}${renderAvatar(project, avatar)}<span class="project-name">${escapeHtml(
    project.name,
  )}</span>${open || !all.length ? '' : foldSummary(all)}<button class="remove" data-remove-project="${escapeHtml(
    project.root,
  )}" title="Tirar da lista">×</button></header>${worktrees}</section>`;
}

export function renderEmpty() {
  return '<div class="empty"><p>Nenhum projeto ainda</p><button class="add-project" data-add-project>Abrir projeto…</button></div>';
}

// Sessions whose folder belongs to no project (a chat opened in ~ or /tmp):
// never hidden, just listed apart.
function renderUnplaced(sessions, selectedId, folds, musicians) {
  if (!sessions?.length) return '';
  const open = isOpen(folds, 'p:', true);
  const list = open
    ? `<ul class="sessions">${sessions.map((session) => renderSession(session, '', selectedId, folds, musicians)).join('')}</ul>`
    : '';
  return `<section class="project unplaced${open ? '' : ' folded'}"><header class="project-head">${foldToggle(
    'p:',
    open,
    'as sessões fora de projetos',
  )}${ICONS.outside}<span class="project-name">Fora de projetos</span>${open ? '' : foldSummary(sessions)}</header>${list}</section>`;
}

// avatars: project root → { uri, accent }
export function renderSidebar(tree, selectedId, selectedWorktree = null, folds = {}, musicians = {}, avatars = {}) {
  const projects = tree.projects.length
    ? tree.projects.map((project) => renderProject(project, selectedId, selectedWorktree, folds, musicians, avatars[project.root])).join('')
    : renderEmpty();
  return projects + renderUnplaced(tree.unplacedSessions, selectedId, folds, musicians);
}

const VOICE_STATES = {
  sleeping: 'esperando "Vizor"',
  listening: 'ouvindo',
  closing: 'ouvindo',
  grace: 'entendi',
  'paused-speaking': 'falando',
  muted: 'mudo',
  meeting: 'pausado (reunião)',
  'sem-modelos': 'baixando modelos',
};

// voice: { state, target } while the voice mode is on (#161).
export function renderTopBar(tree, { voice = null, maestro = false } = {}) {
  const voiceLabel = voice
    ? `<span class="voice-state" data-voice="${escapeHtml(voice.state)}" title="modo voz">🎙 ${escapeHtml(
        VOICE_STATES[voice.state] ?? voice.state,
      )}${voice.target ? ` · ${escapeHtml(voice.target)}` : ''}</span>`
    : '';
  return `<button class="brand" data-action-menu title="Menu do Vizor">vzr · workspace</button><span class="count-item" title="rodando">${ICONS.working}${
    tree.counts.working
  } rodando</span><span class="count-item" title="esperando você">${ICONS.waiting}${tree.counts.waiting} esperando</span>${voiceLabel}<span class="spacer"></span><button class="toggle-maestro" data-toggle-maestro aria-pressed="${maestro}" title="${
    maestro ? 'Sair do modo Maestro' : 'Modo Maestro: você rege pela voz, o Vizor segue o músico em foco'
  }">♪ Maestro</button><button class="add-project" data-add-project>Abrir projeto…</button>`;
}

// Tabs of the selected worktree's terminals, oldest first. Titles come from
// the terminal itself (claude sets it to the chat's title).
export function renderTabs(terminals, activeId, titles) {
  const tabs = terminals
    .map((terminal, index) => {
      const title = terminal.taskTitle || titles?.[terminal.id] || `terminal ${index + 1}`;
      const ended = terminal.alive ? '' : ` · encerrado (${terminal.exitCode ?? '?'})`;
      return `<button class="tab${terminal.alive ? '' : ' exited'}" data-tab="${escapeHtml(terminal.id)}" aria-selected="${
        terminal.id === activeId
      }"><span class="tab-title">${escapeHtml(title)}${ended}</span><span class="tab-close" data-close-tab="${escapeHtml(
        terminal.id,
      )}" title="Fechar">×</span></button>`;
    })
    .join('');
  return `${tabs}<button class="tab-new" data-new-terminal title="Novo terminal" aria-haspopup="menu">+</button>`;
}

export function timeAgo(time, now) {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${plural(days, 'dia', 'dias')}`;
}

// The + menu (#154). conversations: null while loading. One already running
// somewhere is listed but cannot be picked: two processes on one history.
export function renderNewTerminalMenu({ conversations, now }) {
  let resume;
  if (conversations === null) resume = '<p class="menu-note">carregando…</p>';
  else if (!conversations.length) resume = '<p class="menu-note">nenhuma conversa salva nesta pasta</p>';
  else
    resume = conversations
      .map((conversation) => {
        const label = `<span class="menu-label">${escapeHtml(conversation.title ?? 'conversa sem título')}</span>`;
        // Already in one of our tabs: picking it just goes there.
        if (conversation.tab)
          return `<button class="menu-item conversation" role="menuitem" data-go-tab="${escapeHtml(
            conversation.tab,
          )}" title="Ir pra aba dessa conversa">${ICONS.inside}${label}<span class="menu-meta">aberta numa aba</span></button>`;
        return `<button class="menu-item conversation" role="menuitem" data-resume="${escapeHtml(conversation.sessionId)}"${
          conversation.open ? ' disabled title="Essa conversa já está aberta em outro terminal"' : ''
        }>${ICONS.resume}${label}<span class="menu-meta">${
          conversation.open ? 'aberta em outro terminal' : timeAgo(conversation.updatedAt, now)
        }</span></button>`;
      })
      .join('');
  return `<div class="menu" role="menu"><button class="menu-item" role="menuitem" data-new-kind="shell">${ICONS.command}<span class="menu-label">Terminal</span></button><button class="menu-item" role="menuitem" data-new-kind="claude">${ICONS.claude}<span class="menu-label">Nova conversa com o Claude</span></button><div class="menu-heading">Retomar conversa</div>${resume}<button class="menu-item" role="menuitem" data-new-kind="picker"><span class="menu-label">Outra conversa… (seletor do Claude)</span></button></div>`;
}

// status: what main says about bringing an outside chat in (#156); absent
// while it is being asked.
export function renderTerminalPlaceholder(kind, status = null) {
  if (kind === 'outside') {
    const bring = status?.canBring
      ? '<button data-bring>Trazer pro Vizor</button>'
      : status?.why
        ? `<p class="why">${escapeHtml(status.why)}</p>`
        : '';
    return `<p>Essa sessão roda em outro terminal.</p><button data-focus-outside>Ir pro terminal</button>${bring}`;
  }
  if (kind.startsWith('unavailable:'))
    return `<p>Terminal indisponível: ${escapeHtml(kind.slice('unavailable:'.length))}</p>`;
  return '<p>Escolha uma worktree e abra um terminal com +.</p>';
}

// --- inspector (#93): timeline, cards and the live file ---------------------

const NOTE_COPY = {
  'no-diff': 'não deu pra montar o diff',
  'too-large': 'arquivo grande demais pra mostrar o diff',
  binary: 'arquivo binário',
  unreadable: 'não deu pra ler o arquivo',
  writing: 'a IA está escrevendo neste arquivo…',
  deleted: 'arquivo apagado',
  dropped: 'conteúdo antigo descartado pra economizar memória',
  'not-applied': 'essa mudança não chegou a ser aplicada',
};

function clock(time) {
  if (!time) return '';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function editStatusIcon(edit) {
  if (edit.status === 'by-command') return ICONS.command;
  if (edit.status === 'writing') return ICONS.writing;
  if (edit.status === 'not-applied') return ICONS.skipped;
  return ICONS.done;
}

function editStatusLabel(edit) {
  const owner = edit.uncertainOwner ? '<span class="tag uncertain">dono incerto</span>' : '';
  if (edit.status === 'by-command') return `<span class="edit-state command">por comando</span>${owner}`;
  if (edit.status === 'writing') return '<span class="edit-state">escrevendo…</span>';
  if (edit.status === 'not-applied') return '<span class="edit-state">não aplicada</span>';
  return owner;
}

function editCounts(edit) {
  if (edit.status === 'writing') return '';
  if (edit.note) return '±?';
  return `+${edit.added} −${edit.removed}`;
}

export function renderTimeline(task, selectedId, { following, newCount }) {
  const follow =
    !following && newCount > 0 ? `<button data-follow>seguir a IA (${newCount})</button>` : '';
  if (!task?.edits.length) return `${follow}<p class="empty">Nenhuma mudança nesta tarefa ainda.</p>`;
  const rows = task.edits
    .map(
      (edit) =>
        `<li class="edit status-${edit.status}" data-edit="${escapeHtml(edit.id)}" aria-selected="${
          edit.id === selectedId
        }"><div class="edit-line">${editStatusIcon(edit)}<span class="seq">#${edit.seq}</span><span class="edit-path">${escapeHtml(
          edit.relPath,
        )}</span>${editStatusLabel(edit)}<span class="count">${editCounts(edit)}</span><span class="time">${clock(
          edit.startedAt,
        )}</span></div>${edit.reason ? `<div class="reason">${escapeHtml(edit.reason)}</div>` : ''}</li>`,
    )
    .join('');
  return `${follow}<ol class="timeline">${rows}</ol>`;
}

function renderHunkLines(lines) {
  return lines
    .map((line) => `<div class="row ${line[0] === '+' ? 'add' : 'del'}">${escapeHtml(line)}</div>`)
    .join('');
}

const COMMENT_STATE = {
  queued: 'na fila — sai quando a sessão liberar',
  sending: 'enviando…',
  sent: 'enviado',
  copied: 'copiado — cola no terminal da sessão',
  failed: 'não deu pra entregar',
};

const commentButton = (id) =>
  `<button class="comment-button" data-comment="${escapeHtml(id)}" title="Comentar esta mudança">💬</button>`;

export function renderComments(comments) {
  if (!comments?.length) return '';
  return `<ul class="comments">${comments
    .map(
      (comment) =>
        `<li class="comment status-${comment.status}"><span class="comment-text">💬 ${escapeHtml(
          comment.text,
        )}</span><span class="comment-state">${COMMENT_STATE[comment.status] ?? ''}${
          comment.status === 'failed'
            ? ` <button class="copy-comment" data-copy-comment="${escapeHtml(comment.id)}" title="Copiar o comentário">copiar</button>`
            : ''
        }</span></li>`,
    )
    .join('')}</ul>`;
}

export function renderComposer({ edit, draft, error }) {
  return `<header>Comentando #${edit.seq} · ${escapeHtml(edit.relPath)}</header><textarea data-comment-draft rows="3" placeholder="O que o Claude deve saber sobre essa mudança?">${escapeHtml(
    draft ?? '',
  )}</textarea>${error ? `<p class="composer-error">${escapeHtml(error)}</p>` : ''}<div class="composer-actions"><button data-comment-cancel>Cancelar</button><button data-comment-send>Enviar</button></div>`;
}

export function renderCards(task, selectedId, commentsByEdit = {}) {
  if (!task?.edits.length) return '<p class="empty">Nenhuma mudança nesta tarefa ainda.</p>';
  return task.edits
    .map((edit) => {
      const body = edit.note
        ? `<p class="note">${NOTE_COPY[edit.note] ?? edit.note}</p>`
        : `<pre class="code">${renderHunkLines(edit.hunks.flatMap((hunk) => hunk.lines))}</pre>`;
      return `<article class="card status-${edit.status}" data-card="${escapeHtml(edit.id)}"${
        edit.id === selectedId ? ' aria-current="true"' : ''
      }><header>${editStatusIcon(edit)}<span>#${edit.seq} · ${escapeHtml(edit.relPath)} · ${clock(
        edit.startedAt,
      )}</span>${editStatusLabel(edit)}${commentButton(edit.id)}</header>${
        edit.reason ? `<p class="reason">${escapeHtml(edit.reason)}</p>` : ''
      }${body}${renderComments(commentsByEdit[edit.id])}</article>`;
    })
    .join('');
}

export function renderFileView(file, editsById, selectedId, commentsByEdit = {}) {
  const head = `<header class="file-head">${escapeHtml(file.relPath)}</header>`;
  if (file.note) return `${head}<p class="note">${NOTE_COPY[file.note] ?? file.note}</p>`;
  const banner = (id) => {
    const edit = editsById[id];
    if (!edit) return '';
    return `<div class="banner" data-banner="${escapeHtml(id)}"${id === selectedId ? ' aria-current="true"' : ''}><span>#${
      edit.seq
    }${edit.reason ? ` · ${escapeHtml(edit.reason)}` : ''}</span>${commentButton(id)}${renderComments(commentsByEdit[id])}</div>`;
  };
  const seal = file.seal ? `<p class="note seal">${NOTE_COPY[file.seal] ?? file.seal}</p>` : '';
  const unplaced = file.unplaced?.length
    ? `<div class="file-unplaced">edições sem posição neste arquivo: ${file.unplaced
        .map((id) =>
          editsById[id]
            ? `<span data-banner="${escapeHtml(id)}">#${editsById[id].seq}</span>${commentButton(id)}${renderComments(
                commentsByEdit[id],
              )}`
            : '',
        )
        .join(' ')}</div>`
    : '';
  const rows = file.rows
    .map(
      (row, index) =>
        `${(file.anchors?.[index] ?? []).map(banner).join('')}<div class="row ${row.kind}"><span class="gutter">${
          row.oldNo ?? ''
        }</span><span class="gutter">${row.newNo ?? ''}</span><span class="text">${escapeHtml(row.text)}</span></div>`,
    )
    .join('');
  return `${head}${seal}${unplaced}<pre class="code filediff">${rows}</pre>`;
}

// Icon plus a word (#153): the arrows alone did not say what they do.
export function renderInspectorHeader({ mode, width }) {
  const toggle = (value, label) =>
    `<button data-mode="${value}" aria-pressed="${mode === value}">${label}</button>`;
  const widthButton =
    width === 'wide'
      ? `<button class="labeled" data-width-next title="Estreitar o painel de mudanças">${ICONS.panelNarrow}Estreitar</button>`
      : `<button class="labeled" data-width-next title="Alargar o painel de mudanças">${ICONS.panelWiden}Alargar</button>`;
  return `<div class="modes">${toggle('arquivo', 'Arquivo')}${toggle('cards', 'Cards')}</div><span class="spacer"></span>${widthButton}<button class="labeled" data-collapse title="Ocultar o painel de mudanças (Ctrl+Shift+E)">${ICONS.panelHide}Ocultar</button>`;
}

export function renderRail({ editCount, writing }) {
  return `<button class="rail" data-expand title="Mostrar o painel de mudanças (Ctrl+Shift+E)">${ICONS.panelShow}<span class="badge">${editCount}</span>${
    writing ? '<span class="dot writing"></span>' : ''
  }</button>`;
}

// The first summary is the current task, already the "tarefa atual" option:
// listing it again by id would freeze following when picked.
export function renderTaskPicker(summaries, currentId) {
  const options = summaries
    .slice(1)
    .map(
      (summary) =>
        `<option value="${escapeHtml(summary.id)}"${summary.id === currentId ? ' selected' : ''}>${clock(
          summary.startedAt,
        )} · ${escapeHtml(summary.prompt || 'sem prompt')} (${summary.edits})</option>`,
    )
    .join('');
  return `<select data-task-picker><option value="">tarefa atual</option>${options}</select>`;
}
