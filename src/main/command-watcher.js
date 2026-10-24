import path from 'node:path';
import {
  MAX_DIRTY_PATHS,
  POLL_MS,
  changedPaths,
  parseGitStatusZ,
  settleCandidates,
} from './command-changes.js';

// Polls `git status` of each worktree where a session has a task running, to
// catch the files the AI changes without Edit/Write (#94). Polling, not
// fs.watch: git applies .gitignore and costs ~10 ms, where a recursive watch
// would put an inotify watch on every node_modules folder. IO is injected.
export function createCommandWatcher({
  gitStatus,
  statFile,
  explained,
  onChange,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  log = () => {},
}) {
  const roots = new Map(); // root → { owners, sigs: Map|null, pending: Map, timer }

  async function signatures(root, relPaths) {
    const entries = await Promise.all(
      relPaths.map(async (relPath) => [relPath, await statFile(path.join(root, relPath))]),
    );
    return new Map(entries);
  }

  async function poll(root) {
    const state = roots.get(root);
    if (!state) return;
    state.timer = null;
    const output = await gitStatus(root);
    if (roots.get(root) !== state) return; // stopped meanwhile
    if (output === null) {
      log(`command watcher: git status failed in ${root}, not watching it`);
      roots.delete(root);
      return;
    }
    const dirty = parseGitStatusZ(output);
    if (dirty.length > MAX_DIRTY_PATHS) {
      // A mass rewrite: skip it, and take a fresh baseline so it is not
      // replayed as hundreds of cards on the next cycle.
      log(`command watcher: ${dirty.length} changed paths in ${root}, skipping this cycle`);
      state.sigs = null;
      state.pending = new Map();
    } else if (!state.sigs) {
      // Baseline: whatever is dirty when the task starts is not the AI's.
      state.sigs = await signatures(root, dirty);
    } else {
      // Paths that left the dirty set (reverted) are stat-ed once more too.
      const union = await signatures(root, [...new Set([...state.sigs.keys(), ...dirty])]);
      const changed = changedPaths(state.sigs, union);
      const settled = settleCandidates({
        pending: state.pending,
        changed,
        explained: (relPath, detectedAt) => explained(state.owners, path.join(root, relPath), detectedAt),
        now: now(),
      });
      state.pending = settled.pending;
      state.sigs = new Map([...union].filter(([relPath]) => dirty.includes(relPath)));
      for (const relPath of settled.emit)
        onChange({ root, filePath: path.join(root, relPath), owners: [...state.owners] });
    }
    if (roots.get(root) === state) state.timer = setTimer(() => poll(root), POLL_MS);
  }

  function stop(root) {
    const state = roots.get(root);
    if (!state) return;
    if (state.timer) clearTimer(state.timer);
    roots.delete(root);
  }

  function setActive(root, owners) {
    if (!owners.length) {
      stop(root);
      return;
    }
    const state = roots.get(root);
    if (state) {
      state.owners = [...owners];
      return;
    }
    const fresh = { owners: [...owners], sigs: null, pending: new Map(), timer: null };
    roots.set(root, fresh);
    fresh.timer = setTimer(() => poll(root), POLL_MS);
  }

  return {
    setActive,
    stop,
    stopAll: () => [...roots.keys()].forEach(stop),
    activeRoots: () => [...roots.keys()],
  };
}
