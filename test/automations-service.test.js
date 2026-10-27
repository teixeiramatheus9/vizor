import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schedule from '../src/main/automations/schedule.js';
import * as permissions from '../src/main/automations/permissions.js';
import { createAutomationStore } from '../src/main/automations/store.js';
import { createDailyBudget } from '../src/main/automations/budget.js';
import { createAutomationService, automationRunCards } from '../src/main/automations/service.js';

const MIN = 60000;
const T0 = new Date(2026, 9, 27, 8, 0).getTime(); // a Tuesday, 08:00 local

function memStore(initial = []) {
  const files = new Map();
  if (initial.length) files.set('/cfg/automacoes.json', JSON.stringify({ automations: initial }));
  return createAutomationStore({
    file: '/cfg/automacoes.json',
    readFile: async (p) => { if (!files.has(p)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFile: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdir: async () => {},
  });
}

// Each run waits for the test to settle it: runs[i].resolve({ status, costUsd }).
function fakeRunner() {
  const runs = [];
  const runner = {
    runs,
    run: vi.fn((opts) => new Promise((resolve) => { runs.push({ ...opts, resolve }); })),
    cancel: vi.fn((id) => { const r = runs.find((x) => x.automation.id === id && !x.done); if (!r) return false; r.done = true; r.resolve({ status: 'cancelled', costUsd: 0 }); return true; }),
    cancelAll: vi.fn(async () => { for (const r of runs) if (!r.done) { r.done = true; r.resolve({ status: 'cancelled', costUsd: 0 }); } }),
    killAllNow: vi.fn(),
  };
  return runner;
}

function setup({ automations = [], guardEnabled = true, guardReady = true, inflight = [], budgetFile = null, rulesFail = false, storeOverride = null, saveDayCap, extra = {} } = {}) {
  const store = storeOverride ?? memStore(automations);
  const runner = fakeRunner();
  let budgetText = budgetFile;
  const budget = createDailyBudget({ file: 'b', readFile: () => { if (budgetText == null) throw new Error('none'); return budgetText; }, writeFile: (_f, t) => { budgetText = t; }, now: () => new Date() });
  const entries = [];
  const inflightAtAppend = [];
  const history = {
    append: vi.fn(async (id, entry) => { inflightAtAppend.push(structuredClone(pending)); const saved = { ...entry, at: new Date().toISOString(), report: 'r.md' }; entries.push({ id, ...saved }); return saved; }),
    list: vi.fn(async (id, { limit = 20 } = {}) => entries.filter((e) => e.id === id).reverse().slice(0, limit)),
    read: vi.fn(async () => null),
  };
  const skills = { write: vi.fn(async () => '/home/u/.claude/skills/x/SKILL.md'), remove: vi.fn(async () => ({ needsCommit: false })) };
  const rulesDocs = [];
  const order = [];
  const writeGuardRules = vi.fn(async (doc) => { if (rulesFail) throw new Error('disk full'); order.push('rules'); rulesDocs.push(structuredClone(doc)); });
  runner.run.mockImplementation((opts) => { order.push('run'); return new Promise((resolve) => { runner.runs.push({ ...opts, resolve }); }); });
  let pending = structuredClone(inflight);
  const inflightIo = { read: vi.fn(async () => structuredClone(pending)), write: vi.fn(async (list) => { pending = structuredClone(list); }) };
  const worktree = { prepare: vi.fn(async (a) => ({ ok: true, path: `/work/${a.slug}-wt`, branch: `auto/${a.slug}/x` })) };
  const mkdir = vi.fn(async () => {});
  const notify = vi.fn();
  const service = createAutomationService({
    store, runner, budget, history, schedule, permissions, worktree, skills, writeGuardRules,
    inflight: inflightIo, mkdir, notify,
    commandsOf: async () => ({ testCmd: 'npm test', lintCmd: null }),
    removeWorktree: vi.fn(async () => {}),
    ...(saveDayCap ? { saveDayCap } : {}),
    guardEnabled: () => guardEnabled,
    guardReady: () => guardReady,
    baseEnv: () => ({ HOME: '/home/u', PATH: '/bin' }),
    log: () => {},
    now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
    ...extra,
  });
  return { inflightAtAppend, service, store, runner, budget, history, entries, skills, rulesDocs, writeGuardRules, order, inflight: inflightIo, pending: () => pending, worktree, mkdir, notify };
}

const base = (over = {}) => ({ name: 'PRs da manhã', prompt: 'Resuma as PRs.', projectRoot: '/work/app', when: { kind: 'every', minutes: 15 }, ...over });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); });

describe('automation service', () => {
  it('schedules with one timer and runs when due, counting the cost', async () => {
    const t = setup();
    await t.service.start();
    const saved = await t.service.save(base());
    expect(saved.ok).toBe(true);
    const id = saved.automation.id;
    expect(vi.getTimerCount()).toBe(1);
    expect(t.service.state().nextAt).toBe(T0 + 15 * MIN);
    await vi.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(t.runner.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.runner.run).toHaveBeenCalledOnce();
    const call = t.runner.runs[0];
    expect(call.cwd).toBe('/work/app');
    expect(call.args.slice(0, 2)).toEqual(['-p', '/vizor-prs-da-manha']);
    expect(call.env).toMatchObject({ VIZOR_AUTOMATION: id, VIZOR_INTERNAL: '1', PATH: '/bin' });
    expect(call.timeoutMs).toBe(15 * MIN);
    expect(t.service.state().list[0].running).toMatchObject({ startedAt: T0 + 15 * MIN, late: false });
    call.resolve({ status: 'ok', result: 'feito', costUsd: 0.25, durationMs: 1000 });
    await flush();
    expect(t.entries).toEqual([expect.objectContaining({ id, status: 'ok', costUsd: 0.25, result: 'feito', late: false })]);
    expect(t.budget.spent()).toBe(0.25);
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', text: 'a automação PRs da manhã terminou' }));
    const st = t.service.state();
    expect(st.list[0]).toMatchObject({ running: null, last: expect.objectContaining({ status: 'ok' }), next: T0 + 30 * MIN });
    expect(st.budget).toMatchObject({ spent: 0.25, cap: 5, paused: false });
    expect(st.guardEnabled).toBe(true);
    expect(t.service.nameOf(id)).toBe('PRs da manhã');
    expect(t.service.nameOf('nope')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('emits changed and recomputes the single timer on every change', async () => {
    const t = setup();
    await t.service.start();
    const changed = vi.fn();
    t.service.on('changed', changed);
    for (let i = 0; i < 4; i++) await t.service.save(base({ name: `A ${i}`, projectRoot: `/work/p${i}` }));
    expect(changed).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    const [first] = t.service.state().list;
    await t.service.pause(first.id, true);
    expect(t.service.state().list[0]).toMatchObject({ paused: true, next: null });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a missed slot within 24 h runs once at start, marked late', async () => {
    const created = T0 - 3 * 24 * 60 * MIN;
    const t = setup({ automations: [{ ...base({ when: { kind: 'daily', at: '07:00' } }), id: 'd1', createdAt: created, lastRun: T0 - 25 * 60 * MIN }] });
    await t.service.start();
    await flush();
    expect(t.runner.run).toHaveBeenCalledOnce();
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
    await flush();
    expect(t.entries[0]).toMatchObject({ late: true, status: 'ok' });
    // Next is tomorrow at 07:00, not another catch-up run.
    expect(t.service.state().list[0].next).toBe(new Date(2026, 9, 28, 7, 0).getTime());
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(t.runner.run).toHaveBeenCalledOnce();
  });

  it('a missed interval automação runs once, not once per missed slot', async () => {
    const t = setup({ automations: [{ ...base(), id: 'e1', createdAt: T0 - 10 * 60 * MIN, lastRun: T0 - 5 * 60 * MIN }] });
    await t.service.start();
    await flush();
    expect(t.runner.run).toHaveBeenCalledOnce();
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.service.state().list[0].next).toBe(T0 + 15 * MIN);
  });

  it('skip, or a slot older than 24 h, does not run at start', async () => {
    const t = setup({
      automations: [
        { ...base({ when: { kind: 'daily', at: '07:00' }, missed: 'skip' }), id: 's1', createdAt: T0 - 3 * 24 * 60 * MIN, lastRun: T0 - 25 * 60 * MIN },
        { ...base({ name: 'Velha', projectRoot: '/work/b', when: { kind: 'days', days: [0], at: '07:00' } }), id: 's2', createdAt: T0 - 30 * 24 * 60 * MIN, lastRun: T0 - 9 * 24 * 60 * MIN },
      ],
    });
    await t.service.start();
    await flush();
    expect(t.runner.run).not.toHaveBeenCalled();
    expect(t.service.state().list.find((a) => a.id === 's1').next).toBe(new Date(2026, 9, 28, 7, 0).getTime());
  });

  it('the queue runs 1 per project and 2 in total, in order', async () => {
    const t = setup();
    await t.service.start();
    const ids = [];
    for (const [name, root] of [['A1', '/work/a'], ['A2', '/work/a'], ['B1', '/work/b'], ['C1', '/work/c']]) {
      ids.push((await t.service.save(base({ name, projectRoot: root }))).automation.id);
    }
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A1', 'B1']);
    expect(t.service.state().list.filter((a) => a.queued).map((a) => a.name)).toEqual(['A2', 'C1']);
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A1', 'B1', 'A2']);
    t.runner.runs[1].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A1', 'B1', 'A2', 'C1']);
  });

  it('runNow queues behind the project already running and refuses a duplicate', async () => {
    const t = setup();
    await t.service.start();
    const a = (await t.service.save(base({ name: 'A' }))).automation.id;
    const b = (await t.service.save(base({ name: 'B' }))).automation.id;
    expect(await t.service.runNow(a)).toMatchObject({ ok: true });
    expect(await t.service.runNow(b)).toMatchObject({ ok: true, queued: true });
    expect((await t.service.runNow(a)).ok).toBe(false);
    await flush();
    expect(t.runner.run).toHaveBeenCalledOnce();
    expect(await t.service.cancel(b)).toBe(true);
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.runner.run).toHaveBeenCalledOnce();
  });

  it('over-cap blocks the automação until confirm', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    t.runner.runs[0].resolve({ status: 'over-cap', costUsd: 1 });
    await flush();
    expect((await t.store.get(id)).blockedUntilConfirm).toBe(true);
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'over-cap', text: 'a automação PRs da manhã passou do teto' }));
    expect(t.service.state().list[0]).toMatchObject({ blockedUntilConfirm: true, next: null });
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(t.runner.run).toHaveBeenCalledOnce();
    expect((await t.service.runNow(id)).ok).toBe(false);
    await t.service.confirm(id);
    expect((await t.store.get(id)).blockedUntilConfirm).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.run).toHaveBeenCalledTimes(2);
  });

  it('a timeout blocks too, and a block survives a restart', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    t.runner.runs[0].resolve({ status: 'timeout', costUsd: 1 });
    await flush();
    expect(t.entries[0].status).toBe('timeout');
    const again = setup({ storeOverride: t.store });
    await again.service.start();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(again.runner.run).not.toHaveBeenCalled();
  });

  it('the day cap pauses every automação until the next day', async () => {
    const day = `${new Date(T0).getFullYear()}-10-27`;
    const t = setup({ budgetFile: JSON.stringify({ day, spent: 4.5 }) });
    await t.service.start();
    await t.service.save(base({ name: 'A', projectRoot: '/work/a' }));
    await t.service.save(base({ name: 'B', projectRoot: '/work/b' }));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.run).not.toHaveBeenCalled();
    expect(t.service.state().budget).toMatchObject({ spent: 4.5, cap: 5, paused: true });
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'day-cap' }));
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // Midnight: a fresh day, the queue drains.
    // Midnight: a fresh day; each held slot is left to its next regular one (15 min on).
    await vi.advanceTimersByTimeAsync(new Date(2026, 9, 28, 0, 1).getTime() - Date.now());
    expect(t.runner.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A', 'B']);
    expect(t.service.state().budget.paused).toBe(false);
  });

  it('raising the day cap persists it, validates the range and lets the held runs go', async () => {
    const day = `${new Date(T0).getFullYear()}-10-27`;
    const saved = [];
    const t2 = setup({ budgetFile: JSON.stringify({ day, spent: 4.5 }), saveDayCap: async (usd) => { saved.push(usd); } });
    await t2.service.start();
    await t2.service.save(base({ name: 'A', projectRoot: '/work/a' }));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t2.runner.run).not.toHaveBeenCalled();
    expect(t2.service.state().budget.paused).toBe(true);
    for (const bad of [0.4, 100.5, NaN, '9', null, undefined]) {
      expect((await t2.service.setDayCap(bad)).ok).toBe(false);
    }
    expect(saved).toEqual([]);
    expect(await t2.service.setDayCap(8)).toEqual({ ok: true, cap: 8 });
    expect(saved).toEqual([8]);
    await flush();
    expect(t2.runner.run).toHaveBeenCalledOnce();
    expect(t2.service.state().budget).toMatchObject({ cap: 8, paused: false });
  });

  it('keeps the old cap when saving the new one fails', async () => {
    const t = setup({ saveDayCap: async () => { throw new Error('disk'); } });
    await t.service.start();
    expect((await t.service.setDayCap(9)).ok).toBe(false);
    expect(t.service.state().budget.cap).toBe(5);
  });

  it('quit cancels every run, stops the scheduler, and a crash leaves "cancelled" for the next start', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    expect(t.pending()).toEqual([expect.objectContaining({ id, name: 'PRs da manhã' })]);
    // A hard exit: only the sync kill runs, the inflight record stays.
    t.service.killAllNow();
    expect(t.runner.killAllNow).toHaveBeenCalledOnce();
    const next = setup({ storeOverride: t.store, inflight: t.pending() });
    await next.service.start();
    expect(next.entries).toEqual([expect.objectContaining({ id, status: 'cancelled' })]);
    expect(next.pending()).toEqual([]);
    // A clean quit: cancelAll settles the run as cancelled, and nothing else starts.
    await next.service.runNow(id);
    await flush();
    await next.service.shutdown();
    expect(next.runner.cancelAll).toHaveBeenCalledOnce();
    await flush();
    expect(next.entries.at(-1)).toMatchObject({ id, status: 'cancelled' });
    expect(next.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(next.runner.run).toHaveBeenCalledOnce();
    expect(next.notify).not.toHaveBeenCalled();
  });

  it('save writes the skill and the guard rules, and keeps the run state', async () => {
    const t = setup();
    await t.service.start();
    const r = await t.service.save(base({ lastRun: 5, blockedUntilConfirm: true, paused: true }));
    expect(r.ok).toBe(true);
    expect(r.automation).toMatchObject({ slug: 'prs-da-manha', lastRun: null, blockedUntilConfirm: false, paused: false });
    expect(t.skills.write).toHaveBeenCalledWith(expect.objectContaining({ slug: 'prs-da-manha', prompt: 'Resuma as PRs.' }));
    const doc = t.rulesDocs.at(-1);
    expect(doc.version).toBe(1);
    expect(doc.automations[r.automation.id]).toMatchObject({ id: r.automation.id, level: 'read', denyEdits: true });
    expect(doc.automations[r.automation.id].allowBash).toContainEqual({ program: 'npm', argsPrefix: ['test'], extra: 'none' });
    const edited = await t.service.save({ ...r.automation, name: 'Outro nome', createdAt: 1 });
    expect(edited.automation).toMatchObject({ id: r.automation.id, slug: 'prs-da-manha', name: 'Outro nome', createdAt: r.automation.createdAt });
    expect(t.service.state().list).toHaveLength(1);
  });

  it('save refuses edit levels with the guard off, invalid input, and edits while running', async () => {
    const off = setup({ guardEnabled: false });
    await off.service.start();
    expect((await off.service.save(base({ level: 'worktree' }))).error).toMatch(/trava/);
    expect((await off.service.save(base({ level: 'read' }))).ok).toBe(true);
    // An automação saved at an edit level while the guard was on cannot be edited (or run) with it off.
    const onT = setup();
    await onT.service.start();
    const wt = (await onT.service.save(base({ level: 'project' }))).automation;
    const offAgain = setup({ storeOverride: onT.store, guardEnabled: false });
    await offAgain.service.start();
    expect((await offAgain.service.save({ id: wt.id, name: 'Outro' })).error).toMatch(/trava/);
    await offAgain.service.runNow(wt.id);
    await flush();
    expect(offAgain.runner.run).not.toHaveBeenCalled();
    expect(offAgain.entries[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/trava/) });
    const t = setup();
    await t.service.start();
    expect((await t.service.save(base({ when: 'a cada 5 min' }))).ok).toBe(false);
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    expect((await t.service.save({ ...base(), id })).ok).toBe(false);
  });

  it('refuses to write anything when the store could not be read', async () => {
    const store = memStore();
    store.readError = async () => Object.assign(new Error('denied'), { code: 'EACCES' });
    const t = setup({ storeOverride: store });
    await t.service.start();
    const r = await t.service.save(base());
    expect(r).toEqual({ ok: false, error: 'não deu pra ler as automações; nada foi gravado pra não perder o que existe' });
    expect(t.service.state().readError).toBe(r.error);
    expect((await t.service.remove('x')).ok).toBe(false);
  });

  it('worktree level: prepares the worktree, writes its rules before the run, creates gh-empty', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base({ level: 'worktree' }))).automation.id;
    await t.service.runNow(id);
    await flush();
    expect(t.worktree.prepare).toHaveBeenCalledOnce();
    const run = t.runner.runs[0];
    expect(run.cwd).toBe('/work/prs-da-manha-wt');
    expect(t.rulesDocs.at(-1).automations[id]).toMatchObject({ allowEditsUnder: '/work/prs-da-manha-wt', denyEdits: false });
    expect(t.order.slice(-2)).toEqual(['rules', 'run']);
    expect(t.mkdir).toHaveBeenCalledWith(`/home/u/.config/vizor/automacoes/${id}/gh-empty`, { recursive: true });
    expect(run.env.GH_CONFIG_DIR).toBe(`/home/u/.config/vizor/automacoes/${id}/gh-empty`);
    run.resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.entries[0]).toMatchObject({ branch: 'auto/prs-da-manha/x' });
  });

  it('a failed worktree or rules write never spawns, and says why', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base({ level: 'worktree' }))).automation.id;
    t.worktree.prepare.mockResolvedValueOnce({ status: 'failed', reason: 'A worktree tem mudanças.' });
    await t.service.runNow(id);
    await flush();
    await flush();
    expect(t.entries[0]).toMatchObject({ status: 'failed', reason: 'A worktree tem mudanças.' });
    const bad = setup({ rulesFail: true });
    await bad.service.start();
    const id2 = (await bad.service.save(base())).automation.id;
    await bad.service.runNow(id2);
    await flush();
    await flush();
    expect(bad.runner.run).not.toHaveBeenCalled();
    expect(bad.entries[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/regras da trava/) });
    expect(bad.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', text: 'a automação PRs da manhã falhou' }));
  });

  it('a guard denial during the run marks it blocked', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    t.service.noteGuardDenial(id);
    t.service.noteGuardDenial('someone-else');
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
    await flush();
    expect(t.entries[0].status).toBe('blocked');
  });

  it('remove deletes the automação, its rules and, when asked, its skill', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    expect(await t.service.remove(id, { removeSkill: true })).toMatchObject({ ok: true });
    expect(t.skills.remove).toHaveBeenCalledOnce();
    expect(t.rulesDocs.at(-1).automations[id]).toBeUndefined();
    expect(t.service.state().list).toEqual([]);
    expect(t.service.state().nextAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('automation service: review fixes', () => {
  it('save refuses a run cap above the day cap', async () => {
    const t = setup();
    await t.service.start();
    expect(await t.service.save(base({ capUsd: 6 }))).toEqual({ ok: false, error: 'O teto da execução não pode passar do teto do dia (US$ 5,00).' });
    expect(t.service.count()).toBe(0);
    expect((await t.service.save(base({ capUsd: 5 }))).ok).toBe(true);
  });

  it('a day cap lowered below a run cap blocks only that automação, never the queue', async () => {
    const t = setup();
    await t.service.start();
    const big = (await t.service.save(base({ name: 'Grande', projectRoot: '/work/a', capUsd: 2 }))).automation.id;
    const twin = (await t.service.save(base({ name: 'Gêmea', projectRoot: '/work/a', capUsd: 0.5 }))).automation.id;
    await t.service.save(base({ name: 'Pequena', projectRoot: '/work/b', capUsd: 0.5 }));
    // Gêmea runs, Grande waits behind it (same project) when the cap drops.
    await t.service.runNow(twin);
    await t.service.runNow(big);
    await flush();
    expect(t.service.state().list.find((a) => a.id === big).queued).toBe(true);
    expect((await t.service.setDayCap(1)).ok).toBe(true);
    const blocked = t.service.state().list.find((a) => a.id === big);
    expect(blocked).toMatchObject({ queued: false, next: null, capBlocked: 'teto da execução maior que o teto do dia' });
    expect(await t.service.runNow(big)).toEqual({ ok: false, error: 'Bloqueada: teto da execução maior que o teto do dia.' });
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.runs.map((r) => r.automation.name).sort()).toEqual(['Gêmea', 'Gêmea', 'Pequena']);
    expect(t.service.state().budget.paused).toBe(false);
    expect(t.notify).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'day-cap' }));
    for (const r of t.runner.runs) r.resolve({ status: 'ok', costUsd: 0 });
    await flush();
    // Raised again: back on its schedule from now, the blocked slots not caught up.
    expect((await t.service.setDayCap(5)).ok).toBe(true);
    const back = t.service.state().list.find((a) => a.id === big);
    expect(back.capBlocked).toBeNull();
    expect(back.next).toBe(Date.now() + 15 * MIN);
    await flush();
    expect(t.runner.runs.filter((r) => r.automation.id === big)).toHaveLength(0);
  });

  it('records the process group of a run, and a crash restart kills it if it is still claude', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    t.runner.runs[0].onSpawn(4242);
    await flush();
    expect(t.pending()).toEqual([expect.objectContaining({ id, pgid: 4242 })]);
    t.service.killAllNow();
    const kills = [];
    const cmdlines = { 4242: 'node\0/usr/bin/claude\0-p\0/vizor-x\0', 777: 'bash\0' };
    const leftovers = [...t.pending(), { id, name: 'outra', capUsd: 1, pgid: 777 }, { id, name: 'sumiu', capUsd: 1, pgid: 888 }, { id, name: 'sem pgid', capUsd: 1 }];
    const next = setup({
      storeOverride: t.store,
      inflight: leftovers,
      extra: {
        kill: (pid, signal) => kills.push([pid, signal]),
        readCmdline: (pid) => { if (!(pid in cmdlines)) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return cmdlines[pid]; },
      },
    });
    await next.service.start();
    expect(kills).toEqual([[-4242, 'SIGKILL']]);
    expect(next.entries.map((e) => e.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(next.pending()).toEqual([]);
  });

  it('reserves the caps of runs in flight against the day', async () => {
    const t = setup({ budgetFile: JSON.stringify({ day: '2026-10-27', spent: 3.5 }) });
    await t.service.start();
    await t.service.save(base({ name: 'A', projectRoot: '/work/a' }));
    await t.service.save(base({ name: 'B', projectRoot: '/work/b' }));
    await vi.advanceTimersByTimeAsync(15 * MIN);
    // 3.5 + 1 fits; 3.5 + 1 + 1 does not, even before the first one spends.
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A']);
    // Waiting on a run in flight is not the day's pause.
    expect(t.notify).not.toHaveBeenCalled();
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.2 });
    await flush();
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['A', 'B']);
  });

  it('refuses edit-level runs while the guard hook is not confirmed installed', async () => {
    const t = setup({ guardReady: false });
    await t.service.start();
    const p = (await t.service.save(base({ level: 'project' }))).automation.id;
    const r = (await t.service.save(base({ name: 'Leitura', projectRoot: '/work/b' }))).automation.id;
    await t.service.runNow(p);
    await t.service.runNow(r);
    await flush();
    expect(t.runner.runs.map((x) => x.automation.id)).toEqual([r]);
    expect(t.entries.find((e) => e.id === p)).toMatchObject({ status: 'failed', reason: expect.stringMatching(/trava/) });
  });

  it('load() reads everything before start() schedules anything', async () => {
    const t = setup({ automations: [{ ...base(), id: 'e1', createdAt: T0 - 10 * 60 * MIN, lastRun: T0 - 5 * 60 * MIN }] });
    await t.service.load();
    expect(t.service.count()).toBe(1);
    await flush();
    expect(t.runner.run).not.toHaveBeenCalled();
    await t.service.start();
    await flush();
    expect(t.runner.run).toHaveBeenCalledOnce();
  });

  it('wake() keeps a single timer', async () => {
    const t = setup();
    await t.service.start();
    await t.service.save(base());
    expect(vi.getTimerCount()).toBe(1);
    t.service.wake();
    t.service.wake();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('at the day change a held daily slot is left to its next slot, a held weekly one runs late once', async () => {
    const t = setup({ budgetFile: JSON.stringify({ day: '2026-10-27', spent: 4.5 }) });
    vi.setSystemTime(new Date(2026, 9, 27, 7, 0).getTime());
    await t.service.start();
    await t.service.save(base({ name: 'Diária', projectRoot: '/work/a', when: { kind: 'daily', at: '08:00' } }));
    await t.service.save(base({ name: 'Semanal', projectRoot: '/work/b', when: { kind: 'days', days: [2], at: '08:00' } }));
    await vi.advanceTimersByTimeAsync(60 * MIN + 1);
    expect(t.runner.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(new Date(2026, 9, 28, 0, 5).getTime() - Date.now());
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['Semanal']);
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.entries[0]).toMatchObject({ name: 'Semanal', late: true });
    await vi.advanceTimersByTimeAsync(new Date(2026, 9, 28, 8, 1).getTime() - Date.now());
    expect(t.runner.runs.map((r) => r.automation.name)).toEqual(['Semanal', 'Diária']);
  });

  it('drops the inflight record before writing history', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
    await flush();
    expect(t.inflightAtAppend).toEqual([[]]);
  });

  it('shutdown resolves only after the cancelled run is in the history', async () => {
    const t = setup();
    await t.service.start();
    const id = (await t.service.save(base())).automation.id;
    await t.service.runNow(id);
    await flush();
    let done = false;
    const quit = t.service.shutdown().then(() => { done = true; });
    await quit;
    expect(done).toBe(true);
    // No flush in between: the app quits the moment this resolves.
    expect(t.entries.at(-1)).toMatchObject({ id, status: 'cancelled' });
  });

  it('resume() undoes a shutdown whose quit was cancelled', async () => {
    const t = setup();
    await t.service.start();
    await t.service.save(base());
    await t.service.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    t.service.resume();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(t.runner.run).toHaveBeenCalledOnce();
  });

  describe('one slot starts once', () => {
    // The E2E's scenario 6: due a minute before the start, every entry point fired at once.
    const due = () => ({ ...base(), id: 'e6', createdAt: T0 - 60 * MIN, lastRun: T0 - 16 * MIN });

    it('start, wake, resume, runNow, setDayCap and the timer together start it once', async () => {
      const t = setup({ automations: [due()] });
      const changed = [];
      t.service.on('changed', () => changed.push(t.service.state().list[0]));
      const starting = t.service.start();
      t.service.wake();
      t.service.resume();
      await starting;
      t.service.wake();
      t.service.wake();
      expect((await t.service.runNow('e6')).ok).toBe(false);
      await t.service.setDayCap(8.5);
      t.service.resume();
      await flush();
      expect(t.runner.run).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(9000);
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
      await flush();
      t.service.wake();
      await vi.advanceTimersByTimeAsync(14 * MIN);
      t.service.wake();
      expect(t.runner.run).toHaveBeenCalledOnce();
      expect(t.budget.spent()).toBe(0.1);
      expect(t.entries).toHaveLength(1);
      expect(changed.every((a) => !(a.running && a.queued))).toBe(true);
      // The next slot is 15 min after the start, and it runs once too.
      await vi.advanceTimersByTimeAsync(MIN);
      expect(t.runner.run).toHaveBeenCalledTimes(2);
      expect(t.runner.runs[1].automation.id).toBe('e6');
    });

    it('a lastRun that could not be saved still leaves the slot handled', async () => {
      const store = memStore([due()]);
      const patch = store.patch;
      store.patch = (id, partial) => ('lastRun' in partial ? Promise.reject(new Error('disk full')) : patch(id, partial));
      const t = setup({ storeOverride: store });
      await t.service.start();
      await flush();
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
      await flush();
      t.service.wake();
      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(t.runner.run).toHaveBeenCalledOnce();
    });

    it('the queue never holds an automação twice, nor one that is running', async () => {
      const t = setup({ automations: [due(), { ...base({ name: 'Outra' }), id: 'o1', createdAt: T0 - 60 * MIN, lastRun: T0 - 16 * MIN }] });
      await t.service.start();
      await flush();
      // e6 runs, o1 waits behind it (same project).
      expect(t.service.state().list.map((a) => [a.id, Boolean(a.running), a.queued])).toEqual([['e6', true, false], ['o1', false, true]]);
      for (let i = 0; i < 3; i++) t.service.wake();
      expect((await t.service.runNow('o1')).ok).toBe(false);
      expect((await t.service.runNow('e6')).ok).toBe(false);
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
      await flush();
      t.runner.runs[1].resolve({ status: 'ok', costUsd: 0 });
      await flush();
      expect(t.runner.runs.map((r) => r.automation.id)).toEqual(['e6', 'o1']);
    });

    it('a cancelled scheduled slot is not queued again by the next tick', async () => {
      const t = setup({ automations: [due(), { ...base({ name: 'Outra' }), id: 'o1', createdAt: T0 - 60 * MIN, lastRun: T0 - 16 * MIN }] });
      await t.service.start();
      await flush();
      expect(await t.service.cancel('o1')).toBe(true);
      await flush();
      t.service.wake();
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0 });
      await flush();
      expect(t.runner.runs.map((r) => r.automation.id)).toEqual(['e6']);
      // Its next slot still comes, 15 min after the cancel (behind e6's, same project).
      await vi.advanceTimersByTimeAsync(15 * MIN);
      expect(t.runner.runs.map((r) => r.automation.id)).toEqual(['e6', 'e6']);
      expect(t.service.state().list.find((a) => a.id === 'o1').queued).toBe(true);
    });

    // What the E2E saw: "Resumo do dia" (todo dia às 9h, missed: run) is created
    // a little before 09:00; its slot comes due in the middle of a later scenario
    // and runs once, charged at whatever that scenario's fake cost is.
    it('a daily 09:00 slot crossed during the session runs once, as its own run', async () => {
      vi.setSystemTime(new Date(2026, 9, 27, 8, 58).getTime());
      const t = setup();
      await t.service.start();
      const daily = (await t.service.save(base({ name: 'Resumo do dia', when: { kind: 'daily', at: '09:00' } }))).automation.id;
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(t.runner.runs.map((r) => r.automation.id)).toEqual([daily]);
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
      await flush();
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(t.runner.run).toHaveBeenCalledOnce();
    });

    it('and if the app was closed at 09:00, it runs once, late, at the next start', async () => {
      const created = new Date(2026, 9, 27, 8, 58).getTime();
      vi.setSystemTime(new Date(2026, 9, 27, 9, 1).getTime());
      const t = setup({ automations: [{ ...base({ name: 'Resumo do dia', when: { kind: 'daily', at: '09:00' } }), id: 'r1', createdAt: created, lastRun: null }] });
      await t.service.start();
      await flush();
      expect(t.runner.run).toHaveBeenCalledOnce();
      t.runner.runs[0].resolve({ status: 'ok', costUsd: 0.1 });
      await flush();
      expect(t.entries[0]).toMatchObject({ id: 'r1', late: false });
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(t.runner.run).toHaveBeenCalledOnce();
    });
  });
});

describe('automationRunCards', () => {
  it('turns running automações into working cards, waiting while a guard ask is open', () => {
    const list = [
      { id: 'a', name: 'PRs', projectRoot: '/work/a', running: { startedAt: 10, late: true } },
      { id: 'b', name: 'Testes', projectRoot: '/work/b', running: { startedAt: 20, late: false } },
      { id: 'c', name: 'Parada', projectRoot: '/work/c', running: null },
    ];
    const cards = automationRunCards(list, [{ id: 'q', automationId: 'b' }, { id: 'r', sessionId: 's' }]);
    expect(cards).toEqual([
      { id: 'automation:a', automationId: 'a', column: 'working', title: 'PRs', projectRoot: '/work/a', avatarKey: '/work/a', since: 10, late: true, waiting: false, badge: 'automação' },
      { id: 'automation:b', automationId: 'b', column: 'waiting', title: 'Testes', projectRoot: '/work/b', avatarKey: '/work/b', since: 20, late: false, waiting: true, badge: 'automação' },
    ]);
  });
});
