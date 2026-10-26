// Review progress kept per worktree: approved hunks and view prefs, in one JSON
// file written atomically (tmp + rename) and debounced, so clicking through
// hunks costs one write. IO and timers are injected.
import { createHash } from 'node:crypto';

export const storeKey = (worktreePath) => createHash('sha1').update(worktreePath).digest('hex');

const defaultPrefs = () => ({ tab: null, drawerHeight: null, drawerOpen: null, openFiles: [] });

export function createReviewStore({ readFile, writeFile, rename, mkdir, onError, dir, key, debounceMs = 500, setTimeout, clearTimeout }) {
  const file = `${dir}/${key}.json`;
  let approved = new Set();
  let prefs = defaultPrefs();
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve(); // flushes run one at a time: they share the tmp file

  async function load() {
    approved = new Set();
    prefs = defaultPrefs();
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(data?.approved)) approved = new Set(data.approved.filter((id) => typeof id === 'string'));
      if (data?.prefs && typeof data.prefs === 'object') prefs = { ...prefs, ...data.prefs };
    } catch {
      // Missing or corrupt: start empty rather than lose the review screen.
    }
    return { approved: new Set(approved), prefs: { ...prefs } };
  }

  const schedule = () => {
    dirty = true;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush().catch((error) => onError?.(error)); }, debounceMs);
  };

  async function write() {
    if (!dirty) return; // an earlier queued flush already wrote the latest state
    dirty = false;
    const tmp = `${file}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify({ approved: [...approved], prefs }));
      await rename(tmp, file);
    } catch (error) {
      dirty = true; // keep the change so the next flush retries
      throw error;
    }
  }

  function flush() {
    if (timer != null) { clearTimeout(timer); timer = null; }
    const run = chain.then(write);
    chain = run.catch(() => {});
    return run;
  }

  return {
    load,
    flush,
    approve(hunkId, on) {
      if (on) approved.add(hunkId); else approved.delete(hunkId);
      schedule();
    },
    prune(liveIds) {
      const live = new Set(liveIds);
      let changed = false;
      for (const id of approved) if (!live.has(id)) { approved.delete(id); changed = true; }
      if (changed) schedule();
    },
    setPrefs(partial) {
      prefs = { ...prefs, ...partial };
      schedule();
    },
  };
}
