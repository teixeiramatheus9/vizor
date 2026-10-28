// A task's phases and approvals, kept outside the repo in
// ~/.config/vizor/tarefas/<sha1(worktree)>-<issue>.json. The transitions are
// pure (state in, new state out); the store does the IO, injected.
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MODES = ['step', 'trust'];
const KEY = /^[0-9a-f]{40}-\d+$/;

const sha = (algo, text) => createHash(algo).update(text).digest('hex');
export const taskKey = (worktree, issue) => `${sha('sha1', String(worktree))}-${issue}`;

// Only the cases' text counts: the file lines and the steps change all the time.
// A git object id (sha1 or sha256).
export const isObjectId = (v) => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
// Only real object ids, and no key at all when there are none.
function withBlobs(blobs) {
  const kept = Object.fromEntries(Object.entries(blobs ?? {}).filter(([, oid]) => isObjectId(oid)));
  return Object.keys(kept).length ? { blobs: kept } : {};
}
export const contractHash = (plan) => sha('sha256', (plan?.contract ?? []).map((item) => item.text).join('\n'));

export const newTaskState = () => ({
  version: 1,
  mode: 'step', // the default: the músico stops after each step
  contract: null, // { hash } once the dev approved the contract text
  tests: null, // { command, hashes, blobs? } once the dev approved the tests and the command
  reviewed: [], // normalized step texts the dev checked: reordering the plan keeps them
  checkpoints: {}, // step → ref already taken
  openAnyway: false, // the dev opens the PR with unreviewed steps
  // What the task service binds: where the task lives and which chats work on it.
  worktree: null,
  issue: null,
  sessions: [],
  quick: false, // the dev called it a quick task: no gates
  lastRun: null, // { status, tail, at, ms } of the contract's last run
  changedLocked: [], // locked test files whose hash no longer matches
  waitUntick: [], // steps put back by a restore: no checkpoint until they are unticked
  ended: false, // the dev ended it: a tombstone until the issue is started again
  updatedAt: 0,
});
const TAIL_MAX = 8192;

// A step is told apart by its text, not its position: the músico may insert one.
export const stepKey = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const hasContract = (plan) => Array.isArray(plan?.contract) && !plan.error;

// quick | contract | tests | steps | pr
export function nextPhase(state, plan) {
  if (plan?.error) return 'contract';
  if (!Array.isArray(plan?.contract)) return 'quick';
  if (!hasContract(plan) || state.contract?.hash !== contractHash(plan)) return 'contract';
  // The command is what the dev approved: any other text must be approved again.
  if (!state.tests || state.tests.command !== plan.testCommand) return 'tests';
  const steps = plan.steps ?? [];
  if (!steps.length || steps.some((step) => !step.done)) return 'steps';
  const reviewed = steps.every((step) => state.reviewed.includes(stepKey(step.text)));
  return reviewed || state.openAnyway ? 'pr' : 'steps';
}

// A plan that does not parse cleanly cannot be approved: the state stays as it is.
export const approveContract = (state, plan) => (hasContract(plan) ? { ...state, contract: { hash: contractHash(plan) } } : state);
// Nothing to lock or run without a command and at least one test file.
// blobs: file → the git object of the approved content, so a change can show its diff.
export const approveTests = (state, plan, hashes, blobs = {}) => (hasContract(plan) && plan.testCommand && plan.contractFiles?.length > 0
  ? { ...state, tests: { command: plan.testCommand, hashes: { ...hashes }, ...withBlobs(blobs) } }
  : state);
export const unlockTests = (state) => ({ ...state, tests: null });
export const reviewStep = (state, text) => {
  const key = stepKey(text);
  return state.reviewed.includes(key) ? state : { ...state, reviewed: [...state.reviewed, key] };
};
export const setMode = (state, mode) => (MODES.includes(mode) ? { ...state, mode } : state);
export const openAnyway = (state) => ({ ...state, openAnyway: true });
export const markSeenCheckpoint = (state, n, ref) => ({ ...state, checkpoints: { ...state.checkpoints, [n]: ref } });

// Never saved (updatedAt 0) is fresh, not 56 years idle.
export const isStale = (state, now) => Boolean(state?.updatedAt) && now - state.updatedAt > EXPIRY_MS;
// The state while it lives, null once it is over (issue closed or a week idle).
export const expire = (state, { now, issueClosed }) => (issueClosed || isStale(state, now) ? null : state);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Field by field: a hand-edited or old file never puts a wrong type in the state.
function coerce(data) {
  const base = newTaskState();
  return {
    version: 1,
    mode: MODES.includes(data.mode) ? data.mode : base.mode,
    contract: isObject(data.contract) && typeof data.contract.hash === 'string' ? { hash: data.contract.hash } : null,
    tests: isObject(data.tests) && typeof data.tests.command === 'string' && isObject(data.tests.hashes)
      ? {
        command: data.tests.command,
        hashes: Object.fromEntries(Object.entries(data.tests.hashes).filter(([, h]) => typeof h === 'string')),
        ...withBlobs(isObject(data.tests.blobs) ? data.tests.blobs : {}),
      }
      : null,
    reviewed: Array.isArray(data.reviewed) ? data.reviewed.filter((x) => typeof x === 'string') : [],
    checkpoints: isObject(data.checkpoints) ? Object.fromEntries(Object.entries(data.checkpoints).filter(([, r]) => typeof r === 'string')) : {},
    openAnyway: data.openAnyway === true,
    worktree: typeof data.worktree === 'string' && isAbsolute(data.worktree) ? data.worktree : null,
    issue: Number.isInteger(data.issue) && data.issue > 0 ? data.issue : null,
    sessions: Array.isArray(data.sessions) ? data.sessions.filter((x) => typeof x === 'string') : [],
    quick: data.quick === true,
    lastRun: isObject(data.lastRun) && typeof data.lastRun.status === 'string'
      ? {
        status: data.lastRun.status,
        tail: typeof data.lastRun.tail === 'string' ? data.lastRun.tail.slice(-TAIL_MAX) : '',
        at: Number.isFinite(data.lastRun.at) ? data.lastRun.at : 0,
        ms: Number.isFinite(data.lastRun.ms) ? data.lastRun.ms : 0,
      }
      : null,
    changedLocked: Array.isArray(data.changedLocked) ? data.changedLocked.filter((x) => typeof x === 'string') : [],
    waitUntick: Array.isArray(data.waitUntick) ? data.waitUntick.filter((x) => Number.isInteger(x) && x > 0) : [],
    ended: data.ended === true,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
  };
}

const isState = (data) => data && typeof data === 'object' && !Array.isArray(data) && data.version === 1;

export function createTaskStore({ dir, readFile, writeFile, rename, mkdir, readdir, unlink, log, onError, now = Date.now }) {
  const unreadable = new Set(); // keys whose file exists but could not be read: never written over
  let chain = Promise.resolve(); // one operation at a time: they share the tmp file
  const fileOf = (key) => {
    if (!KEY.test(String(key))) throw new Error(`tasks: invalid key ${key}`);
    return join(dir, `${key}.json`);
  };
  const run = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };

  async function read(key) {
    const file = fileOf(key);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        unreadable.add(key);
        log?.(`tasks: could not read ${file}, starting empty (${error.message})`);
      }
      return newTaskState();
    }
    try {
      const data = JSON.parse(text);
      if (!isState(data)) throw new Error('unexpected shape');
      return coerce(data);
    } catch (error) {
      // A bad file is moved aside, never overwritten by the next save.
      const backup = `${file}.corrupt-${now()}`;
      log?.(`tasks: ${file} is corrupt, moved to ${backup} (${error.message})`);
      await rename(file, backup).catch((e) => log?.(`tasks: could not back up ${file} (${e.message})`));
      return newTaskState();
    }
  }

  return {
    load: (key) => run(() => read(key)),
    save: (key, state) => run(async () => {
      const file = fileOf(key);
      if (unreadable.has(key)) throw new Error(`tasks: refusing to overwrite unreadable ${file}`);
      const tmp = `${file}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify({ ...state, updatedAt: now() }, null, 2));
        await rename(tmp, file);
      } catch (error) {
        onError?.(error);
        throw error;
      }
    }),
    list: () => run(async () => {
      let names;
      try {
        names = await readdir(dir);
      } catch (error) {
        if (error?.code !== 'ENOENT') log?.(`tasks: could not list ${dir} (${error.message})`);
        return [];
      }
      const out = [];
      for (const name of names) {
        const key = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (KEY.test(key)) out.push({ key, state: await read(key) });
      }
      return out;
    }),
    remove: (key) => run(async () => {
      const file = fileOf(key);
      try {
        await unlink(file);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        onError?.(error);
        throw error;
      }
      unreadable.delete(key);
      return true;
    }),
  };
}
