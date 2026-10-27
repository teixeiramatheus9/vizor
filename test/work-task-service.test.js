import { describe, expect, it, vi } from 'vitest';
import { createTaskService } from '../src/main/work/task-service.js';
import { EXPIRY_MS, newTaskState, taskKey } from '../src/main/work/task-state.js';
import {
  APPROVE_PROMPT, CONTRACT_APPROVED_PROMPT, DEV_DONE_PROMPT, NEXT_STEP_PROMPT, TRUST_PROMPT, devStepPrompt, restoredPrompt,
} from '../src/main/work/prompts.js';
import { parseTaskPlan } from '../src/main/work/contract.js';

const WT = '/repo';
const PLAN_FILE = '/repo/.vizor/plano-169.md';
const TEST_FILE = '/repo/test/menu.test.js';
const COMMAND = 'npx vitest run test/menu.test.js';

function planText({ done = 0, files = true, command = true, extraFile = false, steps = ['Criar o menu', '[dev] Escolher os itens', 'Testar o menu'] } = {}) {
  return [
    '# Menu', '', '## Contrato', '- clicar no ícone → abre o menu', '- Esc → fecha o menu', '', '## Passos',
    ...steps.flatMap((step, index) => (index < done ? [`- [x] ${step}`, '  porquê: era o passo'] : [`- [ ] ${step}`])),
    '',
    ...(files ? [`Vizor-contrato: test/menu.test.js${extraFile ? ', test/outro.test.js' : ''}`] : []),
    ...(command ? [`Vizor-teste: ${COMMAND}`] : []),
  ].join('\n');
}
const QUICK = '- [ ] ler\n- [ ] fazer\n';

function setup({ plans = { [`${WT}#169`]: planText({ files: false, command: false }) }, stored = {}, closed = [], start = 1_000_000 } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const saved = new Map(Object.entries(stored));
  const store = {
    load: vi.fn(async (key) => (saved.has(key) ? structuredClone(saved.get(key)) : newTaskState())),
    save: vi.fn(async (key, state) => { saved.set(key, { ...structuredClone(state), updatedAt: now() }); }),
    list: vi.fn(async () => [...saved].map(([key, state]) => ({ key, state: structuredClone(state) }))),
    remove: vi.fn(async (key) => saved.delete(key)),
  };
  let n = 0;
  const checkpoints = {
    take: vi.fn(async (worktree, issue, step) => ({ ref: `refs/vizor/tarefa/abc/${issue}/${step}`, sha: `sha${++n}` })),
    restore: vi.fn(async () => ({ restored: ['src/menu.js'], left: ['src/novo.js'] })),
    drop: vi.fn(async () => {}),
  };
  const order = [];
  checkpoints.take.mockImplementation(async (worktree, issue, step) => { order.push(`take ${step}`); return { ref: `refs/vizor/tarefa/abc/${issue}/${step}`, sha: `sha${++n}` }; });
  const verifier = { run: vi.fn(async () => { order.push('run'); return { kind: 'contract', status: 'fail', tail: '1 failing', ms: 7 }; }) };
  const rules = { doc: null, writes: 0 };
  const hashes = { [TEST_FILE]: 'h1', '/repo/test/outro.test.js': 'h2' };
  const working = new Set();
  const timers = [];
  const deps = {
    store,
    checkpoints,
    verifier,
    writeGuardRules: vi.fn(async (doc) => { rules.doc = structuredClone(doc); rules.writes++; }),
    sha256File: vi.fn(async (file) => {
      if (!(file in hashes)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return hashes[file];
    }),
    deliver: vi.fn(async () => 'sent'),
    now,
    git: vi.fn(async () => 'src/menu.js:12:  // TODO(dev): escolha os itens\n'),
    notify: vi.fn(),
    readPlan: vi.fn(async (worktree, issue) => plans[`${worktree}#${issue}`] ?? null),
    isWorking: (sessionId) => working.has(sessionId),
    issueClosed: vi.fn(async (worktree, issue) => closed.includes(issue)),
    changed: vi.fn(),
    setTimer: vi.fn((fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; }),
    clearTimer: vi.fn((timer) => { if (timer) timer.cleared = true; }),
    log: vi.fn(),
  };
  const service = createTaskService(deps);
  return { service, deps, plans, saved, rules, hashes, working, timers, clock, order };
}
const KEY = taskKey(WT, 169);

// A task taken to the steps phase: contract and tests approved.
async function toSteps(ctx) {
  await ctx.service.bind('s1', WT, 169);
  await ctx.service.approveContract('s1');
  ctx.plans[`${WT}#169`] = planText();
  await ctx.service.bind('s1', WT, 169);
  await ctx.service.approveTests('s1');
  ctx.deps.deliver.mockClear();
  ctx.deps.verifier.run.mockClear();
  ctx.deps.checkpoints.take.mockClear();
  ctx.order.length = 0;
}

describe('the task service: binding and the gates', () => {
  it('binding a chat to a task with a contract holds it to the contract phase in the guard rules', async () => {
    const { service, rules, saved } = setup();
    await service.bind('s1', WT, 169);
    expect(rules.doc).toEqual({
      version: 1,
      sessions: { s1: { phase: 'contract', allowEdits: [], planFile: PLAN_FILE } },
      folders: {},
    });
    expect(service.hasActive()).toBe(true);
    expect(saved.get(KEY)).toMatchObject({ worktree: WT, issue: 169, sessions: ['s1'] });
    expect((await service.state('s1')).phase).toBe('contract');
  });

  it('a quick plan (no contract) holds nothing; a chat with no plan file is bound only in memory', async () => {
    const quick = setup({ plans: { [`${WT}#169`]: QUICK } });
    await quick.service.bind('s1', WT, 169);
    expect(quick.rules.doc).toEqual({ version: 1, sessions: {}, folders: {} });
    expect(quick.service.hasActive()).toBe(false);
    expect((await quick.service.state('s1')).phase).toBe('quick');

    const none = setup({ plans: {} });
    await none.service.bind('s9', WT, 300);
    expect(none.saved.size).toBe(0);
    expect(none.service.hasActive()).toBe(false);
  });

  it('onPlan takes the parsed plan as it is and binds the chat that wrote it', async () => {
    const { service, rules } = setup({ plans: {} });
    await service.onPlan('s2', WT, 169, parseTaskPlan(planText({ files: false, command: false })));
    expect(rules.doc.sessions.s2.phase).toBe('contract');
  });

  it('a chat bound to another task leaves the first one', async () => {
    const { service, rules, plans } = setup();
    plans[`${WT}#170`] = planText({ files: false, command: false });
    await service.bind('s1', WT, 169);
    await service.bind('s1', WT, 170);
    expect(Object.keys(rules.doc.sessions)).toEqual(['s1']);
    expect(rules.doc.sessions.s1.planFile).toBe('/repo/.vizor/plano-170.md');
  });

  it('approving the contract opens the tests phase: only the listed test files may be edited', async () => {
    const { service, rules, deps, plans } = setup();
    await service.bind('s1', WT, 169);
    expect(await service.approveContract('s1')).toMatchObject({ ok: true, delivery: 'sent' });
    expect(deps.deliver).toHaveBeenCalledWith('s1', CONTRACT_APPROVED_PROMPT);
    expect(rules.doc.sessions.s1).toEqual({ phase: 'tests', allowEdits: [], planFile: PLAN_FILE });
    plans[`${WT}#169`] = planText({ command: false });
    await service.bind('s1', WT, 169);
    expect(rules.doc.sessions.s1.allowEdits).toEqual([TEST_FILE]);
    expect(await service.approveContract('s1')).toEqual({ error: expect.stringMatching(/já foi aprovado/) });
  });

  it('a malformed contract cannot be approved', async () => {
    const { service, deps } = setup({ plans: { [`${WT}#169`]: '## Contrato\n- só um caso\n\n## Passos\n- [ ] a\n' } });
    await service.bind('s1', WT, 169);
    expect(await service.approveContract('s1')).toEqual({ error: expect.stringMatching(/2 a 6 casos/) });
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('an unknown chat has no task', async () => {
    const { service } = setup();
    expect(await service.state('nobody')).toBeNull();
    expect(await service.approveContract('nobody')).toEqual({ error: expect.any(String) });
  });
});

describe('the task service: the tests', () => {
  it('approving the tests runs the contract first, then hashes and locks the files for the whole folder', async () => {
    const ctx = setup();
    const { service, rules, deps, plans, saved } = ctx;
    await service.bind('s1', WT, 169);
    await service.approveContract('s1');
    plans[`${WT}#169`] = planText({ command: false });
    await service.bind('s1', WT, 169);
    expect(await service.approveTests('s1')).toEqual({ error: expect.stringMatching(/Vizor-teste/) });
    expect(deps.verifier.run).not.toHaveBeenCalled();

    plans[`${WT}#169`] = planText();
    await service.bind('s1', WT, 169);
    const result = await service.approveTests('s1');
    expect(result).toMatchObject({ ok: true, run: { status: 'fail', tail: '1 failing' } });
    expect(deps.verifier.run).toHaveBeenCalledWith(WT, 'contract', { command: 'nice', args: ['-n', '10', 'sh', '-c', COMMAND] });
    expect(deps.verifier.run.mock.invocationCallOrder[0]).toBeLessThan(deps.sha256File.mock.invocationCallOrder[0]);
    expect(rules.doc.folders).toEqual({ [WT]: { locked: [{ path: TEST_FILE, sha256: 'h1' }] } });
    expect(rules.doc.sessions.s1.phase).toBe('steps');
    expect(saved.get(KEY).tests).toEqual({ command: COMMAND, hashes: { 'test/menu.test.js': 'h1' } });
    expect(saved.get(KEY).lastRun).toMatchObject({ status: 'fail', tail: '1 failing' });
    // The baseline: step 1's diff is checkpoint 0 → 1.
    expect(deps.checkpoints.take).toHaveBeenCalledWith(WT, 169, 0);
    expect(saved.get(KEY).checkpoints).toEqual({ 0: 'refs/vizor/tarefa/abc/169/0' });
    expect(deps.deliver).toHaveBeenLastCalledWith('s1', NEXT_STEP_PROMPT);
  });

  it('a second click while the run goes runs nothing more; a cancelled run approves nothing', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    await ctx.service.approveContract('s1');
    ctx.plans[`${WT}#169`] = planText();
    await ctx.service.bind('s1', WT, 169);
    let release;
    ctx.deps.verifier.run.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = ctx.service.approveTests('s1');
    expect(await ctx.service.approveTests('s1')).toEqual({ error: expect.stringMatching(/rodando/) });
    expect((await ctx.service.state('s1')).run.running).toBe(true);
    release({ kind: 'contract', status: 'cancelled', ms: 1 });
    expect(await first).toEqual({ error: expect.stringMatching(/cancelada/) });
    expect(ctx.rules.doc.folders).toEqual({});
    expect(ctx.deps.verifier.run).toHaveBeenCalledTimes(1);
  });

  it('a missing test file refuses the approval and locks nothing', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    await ctx.service.approveContract('s1');
    ctx.plans[`${WT}#169`] = planText();
    await ctx.service.bind('s1', WT, 169);
    delete ctx.hashes[TEST_FILE];
    expect(await ctx.service.approveTests('s1')).toEqual({ error: expect.stringMatching(/test\/menu\.test\.js/) });
    expect(ctx.rules.doc.folders).toEqual({});
    expect(ctx.rules.doc.sessions.s1.phase).toBe('tests');
  });

  it('a test file added to the plan later is not locked; the card is told', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ extraFile: true });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.rules.doc.folders[WT].locked).toEqual([{ path: TEST_FILE, sha256: 'h1' }]);
    const state = await ctx.service.state('s1');
    expect(state.tests.contractFilesChanged).toBe(true);
    expect(state.tests.locked).toEqual(['test/menu.test.js']);
  });

  it('unlocking drops the locks and sends the chat back to the tests phase', async () => {
    const ctx = setup();
    await toSteps(ctx);
    expect(await ctx.service.unlockTests('s1')).toEqual({ ok: true });
    expect(ctx.rules.doc.folders).toEqual({});
    expect(ctx.rules.doc.sessions.s1.phase).toBe('tests');
    expect(await ctx.service.unlockTests('s1')).toEqual({ error: expect.any(String) });
  });

  it('on Stop a locked test whose hash changed is flagged and told, for any chat in that folder; back to the hash clears it', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.hashes[TEST_FILE] = 'mexido';
    expect(await ctx.service.onStop('s7', WT)).toEqual({ changedLocked: ['test/menu.test.js'] });
    expect(ctx.deps.notify).toHaveBeenCalledTimes(1);
    expect(ctx.deps.notify.mock.calls[0][0]).toMatch(/teste do contrato mudou/);
    const state = await ctx.service.state('s1');
    expect(state.tests.changedLocked).toEqual(['test/menu.test.js']);
    expect(state.pr.blockers).toContain('o teste do contrato mudou');
    await ctx.service.onStop('s1', WT);
    expect(ctx.deps.notify).toHaveBeenCalledTimes(1); // told once
    ctx.hashes[TEST_FILE] = 'h1';
    await ctx.service.onStop('s1', WT);
    expect((await ctx.service.state('s1')).tests.changedLocked).toEqual([]);
  });

  it('a deleted locked test counts as changed', async () => {
    const ctx = setup();
    await toSteps(ctx);
    delete ctx.hashes[TEST_FILE];
    expect(await ctx.service.onStop('s1', '/repo/src')).toEqual({ changedLocked: ['test/menu.test.js'] });
  });
});

describe('the task service: the steps', () => {
  it('a new tick takes a checkpoint, then runs the contract; the same plan again does neither', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 1 });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.deps.checkpoints.take).toHaveBeenCalledWith(WT, 169, 1);
    expect(ctx.order).toEqual(['take 1', 'run']);
    expect(ctx.saved.get(KEY).checkpoints).toEqual({ 0: 'refs/vizor/tarefa/abc/169/0', 1: 'refs/vizor/tarefa/abc/169/1' });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.deps.checkpoints.take).toHaveBeenCalledTimes(1);
    expect(ctx.deps.verifier.run).toHaveBeenCalledTimes(1);
    expect((await ctx.service.state('s1')).steps[0]).toMatchObject({ n: 1, done: true, why: 'era o passo', checkpoint: true });
  });

  it('two steps ticked at once take two checkpoints and one run', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 2 });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.order).toEqual(['take 1', 'take 2', 'run']);
  });

  it('a tick in a quick task takes no checkpoint and runs nothing', async () => {
    const ctx = setup({ plans: { [`${WT}#169`]: '- [x] ler\n- [ ] fazer\n' } });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.deps.checkpoints.take).not.toHaveBeenCalled();
    expect(ctx.deps.verifier.run).not.toHaveBeenCalled();
  });

  it('a failed checkpoint is logged and the run still happens', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.deps.checkpoints.take.mockRejectedValueOnce(new Error('sem commits'));
    ctx.plans[`${WT}#169`] = planText({ done: 1 });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.deps.log).toHaveBeenCalledWith(expect.stringMatching(/sem commits/));
    expect(ctx.deps.verifier.run).toHaveBeenCalledTimes(1);
  });

  it('"ok, segue" reviews the step just done and asks for the next; a [dev] step gets the scaffold order', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 1 });
    await ctx.service.bind('s1', WT, 169);
    expect(await ctx.service.okNext('s1')).toMatchObject({ ok: true, delivery: 'sent' });
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', devStepPrompt('Escolher os itens'));
    const state = await ctx.service.state('s1');
    expect(state.steps[0].reviewed).toBe(true);
    expect(state.current).toBe(2);
    expect(state.devTodos).toEqual([{ file: 'src/menu.js', line: 12, note: 'escolha os itens' }]);
    expect(await ctx.service.devDone('s1')).toMatchObject({ ok: true });
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', DEV_DONE_PROMPT);
  });

  it('"fiz" only on a [dev] step; "ok, segue" only once the tests are approved', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    expect(await ctx.service.okNext('s1')).toEqual({ error: expect.any(String) });
    await toSteps(ctx);
    expect(await ctx.service.devDone('s1')).toEqual({ error: expect.stringMatching(/\[dev\]/) });
  });

  it('trust mode tells the chat to go to the end; each step is checked by hand and then the PR opens', async () => {
    const ctx = setup();
    await toSteps(ctx);
    expect(await ctx.service.setMode('s1', 'trust')).toMatchObject({ ok: true });
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', TRUST_PROMPT);
    expect(await ctx.service.setMode('s1', 'wild')).toEqual({ error: expect.any(String) });
    ctx.plans[`${WT}#169`] = planText({ done: 3 });
    await ctx.service.bind('s1', WT, 169);
    let state = await ctx.service.state('s1');
    expect(state.phase).toBe('steps');
    expect(state.pr.blockers).toContain('3 passos sem revisão');
    for (const text of ['Criar o menu', 'Escolher os itens', 'Testar o menu']) await ctx.service.reviewStep('s1', text);
    state = await ctx.service.state('s1');
    expect(state.phase).toBe('pr');
    expect(state.pr).toEqual({ ready: true, blockers: [] });
    expect(await ctx.service.reviewStep('s1', 'não existe')).toEqual({ error: expect.any(String) });
  });

  it('opening anyway lifts the unreviewed steps', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 3 });
    await ctx.service.bind('s1', WT, 169);
    await ctx.service.openAnyway('s1');
    expect((await ctx.service.state('s1')).phase).toBe('pr');
  });

  it('a comment and an undo go to the chat as they are', async () => {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 1 });
    await ctx.service.bind('s1', WT, 169);
    expect(await ctx.service.comment('s1', '  troque o nome  ')).toMatchObject({ ok: true });
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', 'troque o nome');
    expect(await ctx.service.comment('s1', '   ')).toEqual({ error: expect.any(String) });
    expect(await ctx.service.undoStep('s1', 1)).toMatchObject({ ok: true });
    expect(ctx.deps.deliver.mock.calls.at(-1)[1]).toMatch(/Desfaça o passo 1 \(Criar o menu\)/);
    expect(await ctx.service.undoStep('s1', 2)).toEqual({ error: expect.any(String) });
  });
});

describe('the task service: going back', () => {
  async function ticked() {
    const ctx = setup();
    await toSteps(ctx);
    ctx.plans[`${WT}#169`] = planText({ done: 3 });
    await ctx.service.bind('s1', WT, 169);
    return ctx;
  }

  it('refuses while the agent is working', async () => {
    const ctx = await ticked();
    ctx.working.add('s1');
    expect(await ctx.service.restoreBefore('s1', 2)).toEqual({ error: expect.stringMatching(/trabalhando/) });
    expect(ctx.deps.checkpoints.restore).not.toHaveBeenCalled();
  });

  it('restores the checkpoint before step N, tells the chat what stayed and forgets the later checkpoints', async () => {
    const ctx = await ticked();
    const result = await ctx.service.restoreBefore('s1', 2);
    expect(result).toEqual({ ok: true, restored: ['src/menu.js'], left: ['src/novo.js'], delivery: 'sent' });
    expect(ctx.deps.checkpoints.restore).toHaveBeenCalledWith(WT, 'refs/vizor/tarefa/abc/169/1');
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', restoredPrompt(2, ['src/novo.js']));
    expect(ctx.saved.get(KEY).checkpoints).toEqual({ 0: 'refs/vizor/tarefa/abc/169/0', 1: 'refs/vizor/tarefa/abc/169/1' });
  });

  it('before step 1 is the baseline taken when the tests were approved; a restore error comes back in words', async () => {
    const ctx = await ticked();
    expect(await ctx.service.restoreBefore('s1', 1)).toMatchObject({ ok: true });
    expect(ctx.deps.checkpoints.restore).toHaveBeenLastCalledWith(WT, 'refs/vizor/tarefa/abc/169/0');
    expect(ctx.saved.get(KEY).checkpoints).toEqual({ 0: 'refs/vizor/tarefa/abc/169/0' });
    expect(await ctx.service.restoreBefore('s1', 0)).toEqual({ error: expect.any(String) });
    ctx.deps.checkpoints.restore.mockRejectedValueOnce(new Error('Ref inválido'));
    expect(await ctx.service.restoreBefore('s1', 1)).toEqual({ error: 'Ref inválido' });
    expect(await ctx.service.restoreBefore('s1', 3)).toEqual({ error: expect.stringMatching(/antes do passo 3/) });
  });
});

describe('the task service: the end of a task', () => {
  it('ending a task drops its rules, its state and its checkpoints', async () => {
    const ctx = setup();
    await toSteps(ctx);
    expect(await ctx.service.endTask('s1')).toEqual({ ok: true });
    expect(ctx.rules.doc).toEqual({ version: 1, sessions: {}, folders: {} });
    expect(ctx.saved.has(KEY)).toBe(false);
    expect(ctx.deps.checkpoints.drop).toHaveBeenCalledWith(WT, 169);
    expect(await ctx.service.state('s1')).toBeNull();
    expect(ctx.service.hasActive()).toBe(false);
  });

  it('a quick plan takes its baseline when the dev approves it, and a checkpoint per tick after that', async () => {
    const ctx = setup({ plans: { [`${WT}#169`]: '- [x] ler\n- [ ] fazer\n' } });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.deps.checkpoints.take).not.toHaveBeenCalled();
    expect(await ctx.service.approvePlan('s1')).toEqual({ ok: true });
    expect(ctx.deps.checkpoints.take).toHaveBeenCalledWith(WT, 169, 0);
    await ctx.service.approvePlan('s1');
    expect(ctx.deps.checkpoints.take).toHaveBeenCalledTimes(1); // the baseline is taken once
    ctx.plans[`${WT}#169`] = '- [x] ler\n- [x] fazer\n';
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.order).toEqual(['take 0', 'take 1', 'take 2']);
    expect(ctx.deps.verifier.run).not.toHaveBeenCalled();
    expect(await ctx.service.approvePlan('nobody')).toEqual({ error: expect.any(String) });
  });

  it('a quick task lifts the gates and gives the old ok', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    expect(await ctx.service.quick('s1')).toMatchObject({ ok: true, delivery: 'sent' });
    expect(ctx.deps.checkpoints.take).toHaveBeenCalledWith(WT, 169, 0);
    expect(ctx.deps.deliver).toHaveBeenLastCalledWith('s1', APPROVE_PROMPT);
    expect(ctx.rules.doc.sessions).toEqual({});
    expect((await ctx.service.state('s1')).phase).toBe('quick');
  });

  it('on start, a task idle for a week or with its issue closed expires and its rules go away', async () => {
    const idle = { ...newTaskState(), worktree: WT, issue: 169, sessions: ['s1'], updatedAt: 1000 };
    const live = { ...newTaskState(), worktree: WT, issue: 170, sessions: ['s2'], updatedAt: 900_000 };
    const shut = { ...newTaskState(), worktree: WT, issue: 171, sessions: ['s3'], updatedAt: 900_000 };
    const ctx = setup({
      start: 1000 + EXPIRY_MS + 1,
      stored: { [taskKey(WT, 169)]: idle, [taskKey(WT, 170)]: live, [taskKey(WT, 171)]: shut },
      plans: { [`${WT}#169`]: planText(), [`${WT}#170`]: planText(), [`${WT}#171`]: planText() },
      closed: [171],
    });
    await ctx.service.start();
    expect([...ctx.saved.keys()]).toEqual([taskKey(WT, 170)]);
    expect(Object.keys(ctx.rules.doc.sessions)).toEqual(['s2']);
    expect(ctx.deps.checkpoints.drop).toHaveBeenCalledWith(WT, 169);
    expect(ctx.deps.checkpoints.drop).toHaveBeenCalledWith(WT, 171);
    // One timer, for the next expiry.
    expect(ctx.timers.filter((timer) => !timer.cleared)).toHaveLength(1);
    expect(ctx.timers.at(-1).ms).toBeGreaterThanOrEqual(900_000 + EXPIRY_MS - ctx.clock.t);
  });

  it('the expiry timer drops a task gone idle and re-arms for none', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    const timer = ctx.timers.filter((item) => !item.cleared).at(-1);
    expect(timer.ms).toBeGreaterThanOrEqual(EXPIRY_MS);
    ctx.clock.t += EXPIRY_MS + 10_000;
    await timer.fn();
    expect(ctx.rules.doc.sessions).toEqual({});
    expect(ctx.saved.size).toBe(0);
    expect(ctx.timers.filter((item) => !item.cleared && item !== timer)).toHaveLength(0);
  });

  it('on start the rules are rewritten from the saved tasks, and a broken one is dropped', async () => {
    const ctx = setup({
      stored: { [KEY]: { ...newTaskState(), worktree: WT, issue: 169, sessions: ['s1'], updatedAt: 999_000 }, [taskKey('/x', 5)]: { ...newTaskState(), updatedAt: 999_000 } },
      plans: { [`${WT}#169`]: planText() },
    });
    await ctx.service.start();
    expect(ctx.rules.doc.sessions.s1.phase).toBe('contract');
    expect(ctx.saved.has(taskKey('/x', 5))).toBe(false);
  });
});

describe('the task service: opening the PR', () => {
  it('is refused until the task reaches the pr phase, with the card\'s reason', async () => {
    const ctx = setup();
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.service.prRefusal('s1')).toBe('aprove o contrato');
    await toSteps(ctx);
    expect(ctx.service.prRefusal('s1')).toBe('3 passos por fazer');
    ctx.plans[`${WT}#169`] = planText({ done: 3 });
    await ctx.service.bind('s1', WT, 169);
    await ctx.service.reviewStep('s1', 'Criar o menu');
    expect(ctx.service.prRefusal('s1')).toBe('2 passos sem revisão — use abrir assim mesmo');
    await ctx.service.openAnyway('s1');
    expect(ctx.service.prRefusal('s1')).toBeNull();
    ctx.hashes[TEST_FILE] = 'mexido';
    await ctx.service.onStop('s1', WT);
    expect(ctx.service.prRefusal('s1')).toBe('o teste do contrato mudou');
  });

  it('a quick task, or a chat with no task, opens it as before', async () => {
    const ctx = setup({ plans: { [`${WT}#169`]: QUICK } });
    await ctx.service.bind('s1', WT, 169);
    expect(ctx.service.prRefusal('s1')).toBeNull();
    expect(ctx.service.prRefusal('nobody')).toBeNull();
  });
});
