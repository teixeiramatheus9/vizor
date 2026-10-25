import { describe, it, expect } from 'vitest';
import {
  addProject,
  buildWorkspaceTree,
  matchWorktree,
  removeProject,
  taskFileStats,
  staleRoots,
  shouldAutoAdd,
  workspaceAvailable,
} from '../src/main/workspace-model.js';
import { diffHunks } from '../src/main/edit-hunks.js';

const wt = (path, branch = 'main', extra = {}) => ({
  path, branch, head: null, detached: false, bare: false, prunable: false, ...extra,
});
const session = (id, cwd, extra = {}) => ({
  id, cwd, displayName: id, status: 'working', unread: false, needsPermission: false, term: null, ...extra,
});

describe('workspaceAvailable', () => {
  it('is Linux only in v1', () => {
    expect(workspaceAvailable('linux')).toBe(true);
    expect(workspaceAvailable('darwin')).toBe(false);
    expect(workspaceAvailable('win32')).toBe(false);
  });
});

describe('project list', () => {
  it('adds without duplicates, keeping order, and removes', () => {
    const list = addProject(addProject(addProject([], '/a'), '/b'), '/a');
    expect(list).toEqual(['/a', '/b']);
    expect(removeProject(list, '/a')).toEqual(['/b']);
  });
});

describe('matchWorktree', () => {
  it('matches on path-segment boundaries only', () => {
    expect(matchWorktree('/a/bc', ['/a/b'])).toBeNull();
    expect(matchWorktree('/a/b', ['/a/b'])).toBe('/a/b');
  });

  it('picks the deepest worktree', () => {
    expect(matchWorktree('/a/b/c/d', ['/a/b', '/a/b/c'])).toBe('/a/b/c');
  });
});

describe('taskFileStats', () => {
  it('counts each file once, from where it started to where it is now', () => {
    const task = {
      edits: [
        { filePath: '/r/a.js', status: 'applied' },
        { filePath: '/r/a.js', status: 'applied' },
      ],
      files: new Map([['/r/a.js', { start: 'v0\n', current: 'v2\n' }]]),
    };
    const { added, removed } = diffHunks('v0\n', 'v2\n');
    expect(taskFileStats(task)).toEqual([{ filePath: '/r/a.js', added, removed, writing: false }]);
  });

  it('flags a file still being written and unknown counts', () => {
    const task = {
      edits: [{ filePath: '/r/b.js', status: 'writing' }],
      files: new Map([['/r/b.js', { start: null, current: 'x' }]]),
    };
    expect(taskFileStats(task)).toEqual([{ filePath: '/r/b.js', added: null, removed: null, writing: true }]);
  });

  it('lists a file whose only edit is still being written', () => {
    const task = { edits: [{ filePath: '/r/c.js', status: 'writing' }], files: new Map() };
    expect(taskFileStats(task)).toEqual([{ filePath: '/r/c.js', added: null, removed: null, writing: true }]);
  });
});

describe('buildWorkspaceTree', () => {
  const noTask = () => null;

  it('places sessions under the deepest worktree, even across nested projects', () => {
    const tree = buildWorkspaceTree({
      projects: [
        { root: '/r', worktrees: [wt('/r')] },
        { root: '/r/inner', worktrees: [wt('/r/inner', 'dev')] },
      ],
      sessions: [session('s1', '/r/inner/src')],
      taskOf: noTask,
    });
    expect(tree.projects[0].worktrees[0].sessions).toEqual([]);
    expect(tree.projects[1].worktrees[0].sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('keeps a prunable worktree, empty', () => {
    const tree = buildWorkspaceTree({
      projects: [{ root: '/r', worktrees: [wt('/r'), wt('/gone', 'old', { prunable: true })] }],
      sessions: [],
      taskOf: noTask,
    });
    expect(tree.projects[0].worktrees[1]).toMatchObject({ path: '/gone', prunable: true, sessions: [] });
  });

  it('marks sessions running inside the Vizor and carries their files', () => {
    const task = { edits: [{ filePath: '/r/a.js', status: 'writing' }], files: new Map() };
    const tree = buildWorkspaceTree({
      projects: [{ root: '/r', worktrees: [wt('/r')] }],
      sessions: [session('s1', '/r', { term: { VIZOR_PTY_ID: 'p1' } }), session('s2', '/r')],
      taskOf: (id) => (id === 's1' ? task : null),
    });
    const [inside, outside] = tree.projects[0].worktrees[0].sessions;
    expect(inside).toMatchObject({ id: 's1', name: 's1', inside: true });
    expect(inside.files).toHaveLength(1);
    expect(outside).toMatchObject({ inside: false, files: [] });
    expect(tree.projects[0].name).toBe('r');
  });

  it('reports sessions that match no worktree and counts by status', () => {
    const tree = buildWorkspaceTree({
      projects: [{ root: '/r', worktrees: [wt('/r')] }],
      sessions: [
        session('s1', '/elsewhere'),
        session('s2', '/r', { status: 'waiting' }),
        session('s3', '/r'),
      ],
      taskOf: noTask,
    });
    expect(tree.unplaced).toEqual(['/elsewhere']);
    // sessions outside every project are shown, so they count too
    expect(tree.counts).toEqual({ working: 2, waiting: 1 });
  });
});

describe('staleRoots', () => {
  it('re-lists a repo once per unplaced cwd, never in a loop', () => {
    const rootOf = (cwd) => (cwd.startsWith('/r') ? '/r' : null);
    const first = staleRoots({ unplaced: ['/r/wt-gone'], rootOf, rechecked: new Set() });
    expect(first.roots).toEqual(['/r']);
    const second = staleRoots({ unplaced: ['/r/wt-gone'], rootOf, rechecked: first.rechecked });
    expect(second.roots).toEqual([]);
  });

  it('forgets a cwd once it is placed again, so a later removal re-checks', () => {
    const rootOf = () => '/r';
    const first = staleRoots({ unplaced: ['/r/wt'], rootOf, rechecked: new Set() });
    const placed = staleRoots({ unplaced: [], rootOf, rechecked: first.rechecked });
    expect([...placed.rechecked]).toEqual([]);
    expect(staleRoots({ unplaced: ['/r/wt'], rootOf, rechecked: placed.rechecked }).roots).toEqual(['/r']);
  });

  it('ignores cwds outside any known repo', () => {
    expect(staleRoots({ unplaced: ['/tmp'], rootOf: () => null, rechecked: new Set() }).roots).toEqual([]);
  });
});

describe('shouldAutoAdd', () => {
  it('adds a new repo, but never one the user took off the list', () => {
    expect(shouldAutoAdd('/r', [], [])).toBe(true);
    expect(shouldAutoAdd('/r', ['/r'], [])).toBe(false);
    expect(shouldAutoAdd('/r', [], ['/r'])).toBe(false);
    expect(shouldAutoAdd(null, [], [])).toBe(false);
  });
});

describe('sessions outside every project', () => {
  it('are kept as nodes so the workspace can still show them', () => {
    const tree = buildWorkspaceTree({
      projects: [{ root: '/r', worktrees: [wt('/r')] }],
      sessions: [session('s1', '/tmp/scratch')],
      taskOf: () => null,
    });
    expect(tree.unplacedSessions.map((node) => node.id)).toEqual(['s1']);
  });
});
