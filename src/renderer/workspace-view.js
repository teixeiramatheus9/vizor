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

function renderWorktree(worktree, selectedId) {
  const branch = worktree.branch === null ? '(sem branch)' : worktree.branch;
  return `<li class="worktree${worktree.prunable ? ' prunable' : ''}" title="${escapeHtml(worktree.path)}"><div class="worktree-head" data-worktree="${escapeHtml(worktree.path)}">${
    ICONS.branch
  }<span class="branch">${escapeHtml(branch)}</span>${worktree.prunable ? '<span class="tag">(removida)</span>' : ''}</div><ul class="sessions">${worktree.sessions
    .map((session) => renderSession(session, worktree.path, selectedId))
    .join('')}</ul></li>`;
}

function renderProject(project, selectedId) {
  return `<section class="project"><header class="project-head" title="${escapeHtml(project.root)}">${
    ICONS.folder
  }<span class="project-name">${escapeHtml(project.name)}</span><button class="remove" data-remove-project="${escapeHtml(
    project.root,
  )}" title="Tirar da lista">×</button></header><ul class="worktrees">${project.worktrees
    .map((worktree) => renderWorktree(worktree, selectedId))
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

export function renderSidebar(tree, selectedId) {
  const projects = tree.projects.length
    ? tree.projects.map((project) => renderProject(project, selectedId)).join('')
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
