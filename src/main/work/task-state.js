// A task's phases and approvals, kept outside the repo in
// ~/.config/vizor/tarefas/<sha1(worktree)>-<issue>.json. The transitions are
// pure (state in, new state out); the store does the IO, injected.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MODES = ['step', 'trust'];
const KEY = /^[0-9a-f]{40}-\d+$/;

const sha = (algo, text) => createHash(algo).update(text).digest('hex');
export const taskKey = (worktree, issue) => `${sha('sha1', String(worktree))}-${issue}`;

// Only the cases' text counts: the file lines and the steps change all the time.
export const contractHash = (plan) => sha('sha256', (plan?.contract ?? []).map((item) => item.text).join('\n'));

export const newTaskState = () => ({
  version: 1,
  mode: 'step', // the default: the músico stops after each step
  contract: null, // { hash } once the dev approved the contract text
  tests: null, // { command, hashes } once the dev approved the tests and the command
  reviewed: [], // step indexes (0-based, as in the plan) the dev checked
  checkpoints: {}, // step → ref already taken
  openAnyway: false, // the dev opens the PR with unreviewed steps
  updatedAt: 0,
});

const hasContract = (plan) => Array.isArray(plan?.contract) && !plan.error;

// quick | contract | tests | steps | pr
export function nextPhase(state, plan) {
  if (!Array.isArray(plan?.contract)) return 'quick';
  if (!hasContract(plan) || state.contract?.hash !== contractHash(plan)) return 'contract';
  // The command is what the dev approved: any other text must be approved again.
  if (!state.tests || state.tests.command !== plan.testCommand) return 'tests';
  const steps = plan.steps ?? [];
  if (!steps.length || steps.some((step) => !step.done)) return 'steps';
  const reviewed = steps.every((_, index) => state.reviewed.includes(index));
  return reviewed || state.openAnyway ? 'pr' : 'steps';
}

// A plan that does not parse cleanly cannot be approved: the state stays as it is.
export const approveContract = (state, plan) => (hasContract(plan) ? { ...state, contract: { hash: contractHash(plan) } } : state);
export const approveTests = (state, plan, hashes) => (hasContract(plan)
  ? { ...state, tests: { command: plan.testCommand, hashes: { ...hashes } } }
  : state);
export const unlockTests = (state) => ({ ...state, tests: null });
export const reviewStep = (state, n) => (state.reviewed.includes(n) ? state : { ...state, reviewed: [...state.reviewed, n].sort((a, b) => a - b) });
export const setMode = (state, mode) => (MODES.includes(mode) ? { ...state, mode } : state);
export const openAnyway = (state) => ({ ...state, openAnyway: true });
export const markSeenCheckpoint = (state, n, ref) => ({ ...state, checkpoints: { ...state.checkpoints, [n]: ref } });

export const isStale = (state, now) => now - (state?.updatedAt ?? 0) > EXPIRY_MS;
// The state while it lives, null once it is over (issue closed or a week idle).
export const expire = (state, { now, issueClosed }) => (issueClosed || isStale(state, now) ? null : state);

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
      return { ...newTaskState(), ...data };
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
