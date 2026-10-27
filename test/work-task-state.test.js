import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  approveContract, approveTests, createTaskStore, expire, isStale, markSeenCheckpoint, newTaskState,
  nextPhase, openAnyway, reviewStep, setMode, taskKey, unlockTests, EXPIRY_MS,
} from '../src/main/work/task-state.js';
import { parseTaskPlan } from '../src/main/work/contract.js';

const plan = (over = '') => parseTaskPlan(`## Contrato
- a → b
- c → d
${over}
Vizor-contrato: test/a.test.js
Vizor-teste: npm test

## Passos
- [x] um
- [ ] dois
`);
const done = (text) => text.replace('- [ ] dois', '- [x] dois');

describe('taskKey', () => {
  it('is sha1(worktree)-issue', () => {
    expect(taskKey('/w/app', 169)).toBe(`${createHash('sha1').update('/w/app').digest('hex')}-169`);
  });
});

describe('phases', () => {
  it('no contract section is a quick task', () => {
    expect(nextPhase(newTaskState(), parseTaskPlan('- [ ] a'))).toBe('quick');
  });

  it('goes contract, tests, steps, pr', () => {
    let state = newTaskState();
    const p = plan();
    expect(nextPhase(state, p)).toBe('contract');
    state = approveContract(state, p);
    expect(nextPhase(state, p)).toBe('tests');
    state = approveTests(state, p, { 'test/a.test.js': 'h1' });
    expect(state.tests).toEqual({ command: 'npm test', hashes: { 'test/a.test.js': 'h1' } });
    expect(nextPhase(state, p)).toBe('steps');
    const finished = parseTaskPlan(`## Contrato\n- a → b\n- c → d\nVizor-teste: npm test\n## Passos\n- [x] um\n- [x] dois\n`);
    expect(nextPhase(state, finished)).toBe('steps'); // finished steps but neither reviewed
    state = reviewStep(reviewStep(state, 0), 1);
    expect(nextPhase(state, finished)).toBe('pr');
  });

  it('a plan with a contract error never advances past its first approval', () => {
    const bad = parseTaskPlan('## Contrato\n- só um\n');
    expect(bad.error).toBeTruthy();
    expect(approveContract(newTaskState(), bad)).toEqual(newTaskState());
    expect(nextPhase(newTaskState(), bad)).toBe('contract');
  });

  it('"abrir assim mesmo" opens the PR with unreviewed steps; trust mode alone does not', () => {
    const p = parseTaskPlan(`## Contrato\n- a → b\n- c → d\nVizor-teste: npm test\n## Passos\n- [x] um\n`);
    let state = approveTests(approveContract(newTaskState(), p), p, {});
    state = setMode(state, 'trust');
    expect(nextPhase(state, p)).toBe('steps');
    expect(nextPhase(openAnyway(state), p)).toBe('pr');
  });
});

describe('approvals', () => {
  it('editing a contract case drops its approval, and the tests with it', () => {
    const p = plan();
    let state = approveTests(approveContract(newTaskState(), p), p, {});
    const edited = parseTaskPlan('## Contrato\n- a → b\n- c → outra coisa\nVizor-teste: npm test\n## Passos\n- [ ] x');
    expect(nextPhase(state, edited)).toBe('contract');
    // approving the new text brings the old tests approval back only if the command still matches
    state = approveContract(state, edited);
    expect(nextPhase(state, edited)).toBe('steps');
  });

  it('only the case text counts: spacing around the file lines or the steps does not drop it', () => {
    const p = plan();
    const state = approveContract(newTaskState(), p);
    expect(nextPhase(state, plan('\n\n'))).toBe('tests');
    expect(nextPhase(state, parseTaskPlan(done('## Contrato\n- a → b\n- c → d\n## Passos\n- [ ] dois')))).toBe('tests');
  });

  it('a changed Vizor-teste drops the tests approval', () => {
    const p = plan();
    const state = approveTests(approveContract(newTaskState(), p), p, {});
    const changed = parseTaskPlan('## Contrato\n- a → b\n- c → d\nVizor-teste: npm test && rm -rf /\n## Passos\n- [ ] x');
    expect(nextPhase(state, changed)).toBe('tests');
  });

  it('unlockTests drops the tests approval only', () => {
    const p = plan();
    const state = unlockTests(approveTests(approveContract(newTaskState(), p), p, { f: 'h' }));
    expect(state.tests).toBeNull();
    expect(nextPhase(state, p)).toBe('tests');
  });

  it('transitions never mutate their input', () => {
    const state = newTaskState();
    const frozen = structuredClone(state);
    approveContract(state, plan()); reviewStep(state, 0); setMode(state, 'trust'); markSeenCheckpoint(state, 1, 'r');
    expect(state).toEqual(frozen);
  });

  it('reviewStep is idempotent, setMode checks its value, checkpoints are remembered', () => {
    let state = reviewStep(reviewStep(newTaskState(), 2), 2);
    expect(state.reviewed).toEqual([2]);
    expect(setMode(state, 'step').mode).toBe('step');
    expect(setMode(state, 'wild')).toBe(state);
    expect(newTaskState().mode).toBe('step');
    state = markSeenCheckpoint(state, 3, 'refs/vizor/tarefa/169/3');
    expect(state.checkpoints).toEqual({ 3: 'refs/vizor/tarefa/169/3' });
  });
});

describe('expiry', () => {
  it('7 days without activity is stale, and a closed issue expires at once', () => {
    const state = { ...newTaskState(), updatedAt: 1000 };
    expect(isStale(state, 1000 + EXPIRY_MS)).toBe(false);
    expect(isStale(state, 1001 + EXPIRY_MS)).toBe(true);
    expect(expire(state, { now: 2000, issueClosed: false })).toBe(state);
    expect(expire(state, { now: 2000, issueClosed: true })).toBeNull();
    expect(expire(state, { now: 1001 + EXPIRY_MS, issueClosed: false })).toBeNull();
  });
});

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const fs = {
    files,
    readFile: vi.fn(async (f) => { if (!files.has(f)) throw enoent(); return files.get(f); }),
    writeFile: vi.fn(async (f, t) => { files.set(f, t); }),
    rename: vi.fn(async (a, b) => { if (fs.failRename) throw new Error('disk full'); if (!files.has(a)) throw enoent(); files.set(b, files.get(a)); files.delete(a); }),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => [...files.keys()].map((f) => f.split('/').pop())),
    unlink: vi.fn(async (f) => { if (!files.delete(f)) throw enoent(); }),
  };
  return fs;
}
const KEY = `${'a'.repeat(40)}-7`;
const make = (fs, extra = {}) => createTaskStore({ dir: '/cfg/tarefas', ...fs, now: () => 5000, ...extra });

describe('the task store', () => {
  it('loads an empty state when nothing is saved', async () => {
    expect(await make(fakeFs()).load(KEY)).toEqual(newTaskState());
  });

  it('saves atomically (tmp then rename), stamps the activity and loads it back', async () => {
    const fs = fakeFs();
    const store = make(fs);
    await store.save(KEY, setMode(newTaskState(), 'trust'));
    expect(fs.mkdir).toHaveBeenCalledWith('/cfg/tarefas', { recursive: true });
    expect(fs.writeFile.mock.calls[0][0]).toBe(`/cfg/tarefas/${KEY}.json.tmp`);
    expect(fs.files.has(`/cfg/tarefas/${KEY}.json.tmp`)).toBe(false);
    const loaded = await make(fs).load(KEY);
    expect(loaded.mode).toBe('trust');
    expect(loaded.updatedAt).toBe(5000);
  });

  it('serializes concurrent saves: the last one wins and the tmp file is never shared mid-write', async () => {
    const fs = fakeFs();
    let live = 0, peak = 0;
    const write = fs.writeFile;
    fs.writeFile = vi.fn(async (...a) => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 5)); live--; return write(...a); });
    const store = make(fs);
    await Promise.all([store.save(KEY, setMode(newTaskState(), 'trust')), store.save(KEY, setMode(newTaskState(), 'step'))]);
    expect(peak).toBe(1);
    expect((await make(fs).load(KEY)).mode).toBe('step');
  });

  it('a corrupt file is moved aside and loads empty', async () => {
    const file = `/cfg/tarefas/${KEY}.json`;
    const fs = fakeFs({ [file]: '{nope' });
    const log = vi.fn();
    expect(await make(fs, { log }).load(KEY)).toEqual(newTaskState());
    expect(fs.files.get(`${file}.corrupt-5000`)).toBe('{nope');
    expect(fs.files.has(file)).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('a wrong shape counts as corrupt too', async () => {
    const file = `/cfg/tarefas/${KEY}.json`;
    const fs = fakeFs({ [file]: '[1,2]' });
    await make(fs).load(KEY);
    expect(fs.files.has(`${file}.corrupt-5000`)).toBe(true);
  });

  it('an unreadable file is never overwritten', async () => {
    const file = `/cfg/tarefas/${KEY}.json`;
    const fs = fakeFs({ [file]: '{}' });
    fs.readFile = vi.fn(async () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); });
    const onError = vi.fn();
    const store = make(fs, { onError });
    await store.load(KEY);
    await expect(store.save(KEY, newTaskState())).rejects.toThrow(/refusing/);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('reports a failed write through onError and keeps the old state', async () => {
    const fs = fakeFs();
    const onError = vi.fn();
    const store = make(fs, { onError });
    await store.save(KEY, setMode(newTaskState(), 'trust'));
    fs.failRename = true;
    await expect(store.save(KEY, setMode(newTaskState(), 'step'))).rejects.toThrow('disk full');
    expect(onError).toHaveBeenCalled();
    expect((await store.load(KEY)).mode).toBe('trust');
  });

  it('lists only task files, never regras.json, tmp or corrupt backups, and removes one', async () => {
    const fs = fakeFs();
    const store = make(fs);
    await store.save(KEY, newTaskState());
    fs.files.set('/cfg/tarefas/regras.json', '{}');
    fs.files.set(`/cfg/tarefas/${KEY}.json.corrupt-1`, 'x');
    fs.files.set(`/cfg/tarefas/${KEY}.json.tmp`, 'x');
    expect((await store.list()).map((t) => t.key)).toEqual([KEY]);
    expect(await store.remove(KEY)).toBe(true);
    expect(await store.remove(KEY)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.load(KEY)).toEqual(newTaskState());
  });

  it('refuses a key that is not a task key', async () => {
    const store = make(fakeFs());
    await expect(store.load('../regras')).rejects.toThrow(/key/);
    await expect(store.save('regras', newTaskState())).rejects.toThrow(/key/);
  });
});
