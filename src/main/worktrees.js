import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 3000;

function gitWorktreeList(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

// `git worktree list --porcelain`: one record per worktree, blank-line
// separated, main worktree first. A prunable one (deleted on disk, still
// registered) is kept so the workspace can show it as removed.
export function parseWorktreeList(porcelain) {
  const worktrees = [];
  for (const record of String(porcelain ?? '').split(/\n\s*\n/)) {
    const lines = record.split('\n').filter(Boolean);
    const first = lines[0];
    if (!first?.startsWith('worktree ')) continue;
    const worktree = { path: first.slice('worktree '.length), branch: null, head: null, detached: false, bare: false, prunable: false };
    for (const line of lines.slice(1)) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'HEAD') worktree.head = value;
      else if (key === 'branch') worktree.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') worktree.detached = true;
      else if (key === 'bare') worktree.bare = true;
      else if (key === 'prunable') worktree.prunable = true;
    }
    worktrees.push(worktree);
  }
  return worktrees;
}

// A folder outside git is still a project: one pseudo-worktree, the folder.
export async function listWorktrees(root) {
  const worktrees = parseWorktreeList(await gitWorktreeList(root));
  if (worktrees.length) return worktrees;
  return [{ path: root, branch: null, head: null, detached: false, bare: false, prunable: false }];
}

// The project a folder belongs to: its repo's MAIN worktree, so a session in a
// linked worktree lands under the same project as the main checkout.
export async function repoRootOf(dir) {
  return parseWorktreeList(await gitWorktreeList(dir))[0]?.path ?? null;
}
