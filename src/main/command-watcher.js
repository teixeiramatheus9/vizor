import path from 'node:path';
import {
  MAX_DIRTY_PATHS,
  POLL_MS,
  changedPaths,
  parseGitStatusEntries,
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
  onBaseline = () => {},
  // Optional: commits/checkouts/pulls touch CLEAN files git status never
  // lists — a moved HEAD names them (#131).
  gitHead = null,
  gitChangedBetween = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  log = () => {},
}) {
  const roots = new Map(); // root → { owners, sigs: Map|null, pending: Map, timer, head }
  // A folder git keeps failing in is left alone for a while, doubling up to
  // ten minutes, instead of a dead git process + log line per event (#129).
  const failures = new Map(); // root → { until, wait }
  const BACKOFF_FIRST_MS = 30000;
  const BACKOFF_MAX_MS = 10 * 60000;

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
    try {
      await cycle(root, state);
    } catch (error) {
      log(`command watcher: cycle failed in ${root}: ${error}`);
    } finally {
      // One bad cycle (a stat error, a vanished folder) must not stop the loop.
      if (roots.get(root) === state && !state.timer) state.timer = setTimer(() => poll(root), POLL_MS);
    }
  }

  async function cycle(root, state) {
    const output = await gitStatus(root);
    if (roots.get(root) !== state) return; // stopped meanwhile
    if (output === null) {
      const wait = Math.min((failures.get(root)?.wait ?? BACKOFF_FIRST_MS / 2) * 2, BACKOFF_MAX_MS);
      failures.set(root, { until: now() + wait, wait });
      log(`command watcher: git status failed in ${root}, retrying in ${Math.round(wait / 1000)} s`);
      roots.delete(root);
      return;
    }
    failures.delete(root);
    const entries = parseGitStatusEntries(output);
    const dirty = entries.map((entry) => entry.path);
    const head = gitHead ? await gitHead(root) : null;
    if (!state.sigs) {
      // Baseline: whatever is dirty when the task starts is not the AI's.
      state.sigs = await signatures(root, dirty);
      state.head = head;
      onBaseline({ root, files: dirty.map((relPath) => path.join(root, relPath)) });
      return;
    }
    // Paths that left the dirty set (reverted) are stat-ed once more too.
    const union = await signatures(root, [...new Set([...state.sigs.keys(), ...dirty])]);
    const changed = changedPaths(state.sigs, union);
    let headSeen = true;
    if (head && state.head && head !== state.head && gitChangedBetween) {
      const moved = await gitChangedBetween(root, state.head, head);
      if (moved === null) headSeen = false; // diff failed: look at this move again next cycle
      for (const relPath of moved ?? []) {
        if (!changed.includes(relPath)) changed.push(relPath);
        // Its "before" is the old HEAD's version — the index already matches disk.
        if (!state.headOrigin.has(relPath)) state.headOrigin.set(relPath, state.head);
      }
    }
    if (headSeen) state.head = head ?? state.head;
    state.sigs = new Map([...union].filter(([relPath]) => dirty.includes(relPath)));
    if (changed.length > MAX_DIRTY_PATHS) {
      // A mass rewrite (lockfile churn, a codegen): absorbed into the new
      // signatures, never replayed as hundreds of cards.
      log(`command watcher: ${changed.length} changed paths in ${root}, skipping this cycle`);
      state.pending = new Map();
      state.headOrigin = new Map();
      return;
    }
    const settled = settleCandidates({
      pending: state.pending,
      changed,
      explained: (relPath, detectedAt) => explained(state.owners, path.join(root, relPath), detectedAt),
      now: now(),
    });
    state.pending = settled.pending;
    // Origins of paths no longer pending (explained) must not outlive them.
    for (const relPath of [...state.headOrigin.keys()])
      if (!state.pending.has(relPath) && !settled.emit.includes(relPath)) state.headOrigin.delete(relPath);
    for (const relPath of settled.emit) {
      onChange({
        root,
        filePath: path.join(root, relPath),
        owners: [...state.owners],
        untracked: entries.some((entry) => entry.path === relPath && entry.untracked),
        fromHead: state.headOrigin.get(relPath) ?? null,
      });
      state.headOrigin.delete(relPath);
    }
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
    if ((failures.get(root)?.until ?? 0) > now()) return; // backing off (#129)
    const fresh = { owners: [...owners], sigs: null, pending: new Map(), timer: null, head: null, headOrigin: new Map() };
    roots.set(root, fresh);
    // Baseline right away: a change in the first poll interval would
    // otherwise be absorbed into it (#128).
    fresh.timer = setTimer(() => poll(root), 0);
  }

  return {
    setActive,
    stop,
    stopAll: () => [...roots.keys()].forEach(stop),
    activeRoots: () => [...roots.keys()],
  };
}
