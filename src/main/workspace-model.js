import path from 'node:path';
import { diffHunks } from './edit-hunks.js';

// Pure shaping of the workspace sidebar: projects → worktrees → sessions →
// files touched in the current task. No git, no fs: index.js feeds it.

export function workspaceAvailable(platform) {
  return platform === 'linux';
}

export function addProject(list, root) {
  return list.includes(root) ? [...list] : [...list, root];
}

export function removeProject(list, root) {
  return list.filter((candidate) => candidate !== root);
}

// Auto-add brings in the repo of every session — except one the user took
// off the list, which stays off until they add it back by hand.
// Never the home folder itself: a dotfiles repo there (yadm, bare repo)
// would swallow every session outside other repos (#104).
export function shouldAutoAdd(root, projects, dismissed, home = null) {
  return Boolean(root) && root !== home && !projects.includes(root) && !dismissed.includes(root);
}

// An unplaced cwd inside a known repo usually means a worktree was just
// created: re-list that repo — ONCE per cwd. A cwd still unplaced after the
// re-list (worktree removed, symlinked path) must not trigger another one, or
// the refresh would chase it forever. A cwd that gets placed again is
// forgotten, so a later removal re-checks.
export function staleRoots({ unplaced, rootOf, rechecked }) {
  const next = new Set([...rechecked].filter((cwd) => unplaced.includes(cwd)));
  const roots = [];
  for (const cwd of unplaced) {
    if (next.has(cwd)) continue;
    const root = rootOf(cwd);
    if (!root) continue;
    next.add(cwd);
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots, rechecked: next };
}

function contains(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Deepest wins: a checkout nested inside another repo's folder owns its own
// sessions — a session must never show up under two worktrees.
export function matchWorktree(cwd, worktreePaths) {
  let best = null;
  for (const candidate of worktreePaths)
    if (contains(candidate, cwd) && (!best || candidate.length > best.length)) best = candidate;
  return best;
}

// One line per file, start-of-task against now: two edits on the same lines
// count once, as the person reading the diff sees them.
export function taskFileStats(task) {
  const order = [];
  for (const filePath of [...(task?.files?.keys() ?? []), ...(task?.edits ?? []).map((edit) => edit.filePath)])
    if (!order.includes(filePath)) order.push(filePath);
  return order.map((filePath) => {
    const file = task.files?.get(filePath);
    const writing = task.edits.some((edit) => edit.filePath === filePath && edit.status === 'writing');
    const diff =
      typeof file?.start === 'string' && typeof file?.current === 'string'
        ? diffHunks(file.start, file.current)
        : null;
    return { filePath, added: diff?.added ?? null, removed: diff?.removed ?? null, writing };
  });
}

function sessionNode(session, taskOf) {
  return {
    id: session.id,
    name: session.displayName ?? session.id,
    status: session.status,
    unread: Boolean(session.unread),
    needsPermission: Boolean(session.needsPermission),
    ptyId: session.term?.VIZOR_PTY_ID ?? null,
    inside: Boolean(session.term?.VIZOR_PTY_ID),
    files: taskFileStats(taskOf(session.id)),
  };
}

export function buildWorkspaceTree({ projects, sessions, taskOf }) {
  const nodes = projects.map(({ root, worktrees }) => ({
    root,
    name: path.basename(root),
    worktrees: worktrees.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      prunable: worktree.prunable,
      sessions: [],
    })),
  }));
  const byPath = new Map(nodes.flatMap((project) => project.worktrees.map((node) => [node.path, node])));
  const unplaced = [];
  const unplacedSessions = [];
  const counts = { working: 0, waiting: 0 };
  for (const session of sessions) {
    const match = session.cwd ? matchWorktree(session.cwd, [...byPath.keys()]) : null;
    if (match) byPath.get(match).sessions.push(sessionNode(session, taskOf));
    else {
      if (session.cwd && !unplaced.includes(session.cwd)) unplaced.push(session.cwd);
      // Never orphaned (spec §9.1): a session outside every project is still shown.
      unplacedSessions.push(sessionNode(session, taskOf));
    }
    if (session.status === 'working') counts.working += 1;
    else if (session.status === 'waiting') counts.waiting += 1;
  }
  return { projects: nodes, unplaced, unplacedSessions, counts };
}

// Quitting kills the workspace's terminals (they live in this process), so a
// live one makes the quit ask first.
export function quitPrompt(aliveCount) {
  if (!aliveCount) return null;
  const message =
    aliveCount === 1
      ? '1 sessão rodando no workspace vai ser encerrada.'
      : `${aliveCount} sessões rodando no workspace vão ser encerradas.`;
  // The tabs come back on the next start (#155): say so, it changes the answer.
  return {
    message,
    detail: 'As abas e as conversas voltam quando você abrir o Vizor de novo.',
    buttons: ['Encerrar mesmo assim', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
  };
}

// Resize requests come from the window: integers only, and a ceiling so a bad
// message cannot ask the pty for a giant screen (#115).
const MAX_TERMINAL_SIZE = 1000;
export function clampTerminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  return { cols: Math.min(cols, MAX_TERMINAL_SIZE), rows: Math.min(rows, MAX_TERMINAL_SIZE) };
}

// Sessions that left the registry since the last look, by whatever path
// (closed, reaped, pruned) — their edits and comments must go too (#137).
export function removedIds(previousIds, currentIds) {
  const current = new Set(currentIds);
  return [...previousIds].filter((id) => !current.has(id));
}
