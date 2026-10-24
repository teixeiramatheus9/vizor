// Pure HTML builders for the workspace window: no DOM access, so vitest can
// run them and the renderer only swaps innerHTML. Everything interpolated goes
// through escapeHtml — session names and paths come from the user's disk.

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
  inside: svg('<rect x="1.5" y="2" width="9" height="8" rx="1"/><path d="M3.5 5l1.5 1.2L3.5 7.4M6 7.5h2.5"/>'),
  outside: svg('<path d="M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5L5.5 6.5"/>'),
  branch: svg('<circle cx="3.5" cy="3" r="1.2"/><circle cx="3.5" cy="9" r="1.2"/><circle cx="8.5" cy="4.5" r="1.2"/><path d="M3.5 4.2v3.6M8.5 5.7c0 1.8-2.5 1.6-4.4 2.6"/>'),
  folder: svg('<path d="M1.5 3.5a1 1 0 0 1 1-1h2.2l1 1.2h3.8a1 1 0 0 1 1 1v4.8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z"/>'),
  writing: svg('<path d="M8 2l2 2-5.5 5.5H2.5V7.5z"/>'),
  skipped: svg('<circle cx="6" cy="6" r="4.5"/><path d="M3 9l6-6"/>'),
};

const STATUS_LABEL = {
  permission: 'pedindo permissão',
  waiting: 'esperando você',
  done: 'pronto',
  working: 'rodando',
};

function statusKey(session) {
  if (session.needsPermission) return 'permission';
  if (session.status === 'waiting') return 'waiting';
  if (session.status === 'done') return 'done';
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

function renderSession(session, worktreePath, selectedId) {
  const key = statusKey(session);
  const where = session.inside ? 'inside' : 'outside';
  const files = session.files.length
    ? `<ul class="files">${session.files.map((file) => renderFile(file, worktreePath)).join('')}</ul>`
    : '';
  return `<li class="session status-${key}${session.unread ? ' unread' : ''}" data-session="${escapeHtml(session.id)}" aria-selected="${
    session.id === selectedId
  }"><span class="status" title="${STATUS_LABEL[key]}">${ICONS[key]}</span><span class="session-name">${escapeHtml(
    session.name,
  )}</span><span class="where" title="${session.inside ? 'no Vizor' : 'em outro terminal'}">${ICONS[where]}</span>${files}</li>`;
}

function renderWorktree(worktree, selectedId, selectedWorktree) {
  const branch = worktree.branch === null ? '(sem branch)' : worktree.branch;
  return `<li class="worktree${worktree.prunable ? ' prunable' : ''}" title="${escapeHtml(worktree.path)}"><div class="worktree-head" data-worktree="${escapeHtml(worktree.path)}"${
    worktree.path === selectedWorktree ? ' aria-current="true"' : ''
  }>${
    ICONS.branch
  }<span class="branch">${escapeHtml(branch)}</span>${worktree.prunable ? '<span class="tag">(removida)</span>' : ''}</div><ul class="sessions">${worktree.sessions
    .map((session) => renderSession(session, worktree.path, selectedId))
    .join('')}</ul></li>`;
}

function renderProject(project, selectedId, selectedWorktree) {
  return `<section class="project"><header class="project-head" title="${escapeHtml(project.root)}">${
    ICONS.folder
  }<span class="project-name">${escapeHtml(project.name)}</span><button class="remove" data-remove-project="${escapeHtml(
    project.root,
  )}" title="Tirar da lista">×</button></header><ul class="worktrees">${project.worktrees
    .map((worktree) => renderWorktree(worktree, selectedId, selectedWorktree))
    .join('')}</ul></section>`;
}

export function renderEmpty() {
  return '<div class="empty"><p>Nenhum projeto ainda</p><button class="add-project" data-add-project>Abrir projeto…</button></div>';
}

// Sessions whose folder belongs to no project (a chat opened in ~ or /tmp):
// never hidden, just listed apart.
function renderUnplaced(sessions, selectedId) {
  if (!sessions?.length) return '';
  return `<section class="project unplaced"><header class="project-head">${ICONS.outside}<span class="project-name">Fora de projetos</span></header><ul class="sessions">${sessions
    .map((session) => renderSession(session, '', selectedId))
    .join('')}</ul></section>`;
}

export function renderSidebar(tree, selectedId, selectedWorktree = null) {
  const projects = tree.projects.length
    ? tree.projects.map((project) => renderProject(project, selectedId, selectedWorktree)).join('')
    : renderEmpty();
  return projects + renderUnplaced(tree.unplacedSessions, selectedId);
}

export function renderTopBar(tree) {
  return `<span class="brand">vzr · workspace</span><span class="count-item" title="rodando">${ICONS.working}${
    tree.counts.working
  } rodando</span><span class="count-item" title="esperando você">${ICONS.waiting}${tree.counts.waiting} esperando</span><span class="spacer"></span><button class="add-project" data-add-project>Abrir projeto…</button>`;
}

// Tabs of the selected worktree's terminals, oldest first. Titles come from
// the terminal itself (claude sets it to the chat's title).
export function renderTabs(terminals, activeId, titles) {
  const tabs = terminals
    .map((terminal, index) => {
      const title = titles?.[terminal.id] || `terminal ${index + 1}`;
      const ended = terminal.alive ? '' : ` · encerrado (${terminal.exitCode ?? '?'})`;
      return `<button class="tab${terminal.alive ? '' : ' exited'}" data-tab="${escapeHtml(terminal.id)}" aria-selected="${
        terminal.id === activeId
      }"><span class="tab-title">${escapeHtml(title)}${ended}</span><span class="tab-close" data-close-tab="${escapeHtml(
        terminal.id,
      )}" title="Fechar">×</span></button>`;
    })
    .join('');
  return `${tabs}<button class="tab-new" data-new-terminal title="Novo terminal com claude">+</button>`;
}

export function renderTerminalPlaceholder(kind) {
  if (kind === 'outside')
    return '<p>Essa sessão roda em outro terminal.</p><button data-focus-outside>Ir pro terminal</button>';
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
};

function clock(time) {
  if (!time) return '';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function editStatusIcon(edit) {
  if (edit.status === 'writing') return ICONS.writing;
  if (edit.status === 'not-applied') return ICONS.skipped;
  return ICONS.done;
}

function editStatusLabel(edit) {
  if (edit.status === 'writing') return '<span class="edit-state">escrevendo…</span>';
  if (edit.status === 'not-applied') return '<span class="edit-state">não aplicada</span>';
  return '';
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

export function renderCards(task, selectedId) {
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
      )}</span>${editStatusLabel(edit)}</header>${
        edit.reason ? `<p class="reason">${escapeHtml(edit.reason)}</p>` : ''
      }${body}</article>`;
    })
    .join('');
}

export function renderFileView(file, editsById, selectedId) {
  const head = `<header class="file-head">${escapeHtml(file.relPath)}</header>`;
  if (file.note) return `${head}<p class="note">${NOTE_COPY[file.note] ?? file.note}</p>`;
  const banner = (id) => {
    const edit = editsById[id];
    if (!edit) return '';
    return `<div class="banner" data-banner="${escapeHtml(id)}"${id === selectedId ? ' aria-current="true"' : ''}>#${
      edit.seq
    }${edit.reason ? ` · ${escapeHtml(edit.reason)}` : ''}</div>`;
  };
  const unplaced = file.unplaced?.length
    ? `<div class="unplaced">edições sem posição neste arquivo: ${file.unplaced
        .map((id) => (editsById[id] ? `<span data-banner="${escapeHtml(id)}">#${editsById[id].seq}</span>` : ''))
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
  return `${head}${unplaced}<pre class="code filediff">${rows}</pre>`;
}

export function renderInspectorHeader({ mode, width }) {
  const toggle = (value, label) =>
    `<button data-mode="${value}" aria-pressed="${mode === value}">${label}</button>`;
  const widthTitle = width === 'wide' ? 'Mais estreito' : 'Mais largo';
  return `<div class="modes">${toggle('arquivo', 'Arquivo')}${toggle('cards', 'Cards')}</div><span class="spacer"></span><button data-width-next title="${widthTitle}">${
    width === 'wide' ? '⇥' : '⇤'
  }</button><button data-collapse title="Recolher">▸</button>`;
}

export function renderRail({ editCount, writing }) {
  return `<button class="rail" data-expand title="Mostrar mudanças"><span class="badge">${editCount}</span>${
    writing ? '<span class="dot writing"></span>' : ''
  }</button>`;
}

export function renderTaskPicker(summaries, currentId) {
  const options = summaries
    .map(
      (summary) =>
        `<option value="${escapeHtml(summary.id)}"${summary.id === currentId ? ' selected' : ''}>${clock(
          summary.startedAt,
        )} · ${escapeHtml(summary.prompt || 'sem prompt')} (${summary.edits})</option>`,
    )
    .join('');
  return `<select data-task-picker><option value="">tarefa atual</option>${options}</select>`;
}
