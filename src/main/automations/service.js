// The automações service: one setTimeout for the next due run, a fair queue
// (1 per project, 2 in total), the per-run block after over-cap/timeout and
// the day-wide pause when the daily cap is spent. Every IO is injected.
const MAX_RUNNING = 2;
// A timer is clamped so a suspend (the monotonic clock stops while the
// machine sleeps) or a wall-clock change is noticed within the hour.
const MAX_SLEEP_MS = 3600000;
// A slot noticed later than this (the machine slept) follows the missed-run rule.
const LATE_TOLERANCE_MS = 5 * 60000;
const EDIT_LEVELS = new Set(['worktree', 'project']);
const EDITABLE = ['name', 'prompt', 'projectRoot', 'when', 'level', 'model', 'capUsd', 'timeoutMin', 'missed', 'skillScope'];
const BLOCKING = new Set(['over-cap', 'timeout']);

export const READ_ERROR = 'não deu pra ler as automações; nada foi gravado pra não perder o que existe';
const GUARD_OFF = 'A trava está desligada: assim, só o nível "Ler e relatar" pode ser usado. Ligue a trava pra editar numa worktree ou no projeto.';

const NOTICE = {
  ok: (name) => `a automação ${name} terminou`,
  failed: (name) => `a automação ${name} falhou`,
  blocked: (name) => `a automação ${name} foi barrada pela trava`,
  'over-cap': (name) => `a automação ${name} passou do teto`,
  timeout: (name) => `a automação ${name} passou do tempo`,
};
const DAY_CAP_NOTICE = 'as automações passaram do teto do dia e pausaram até amanhã';

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const nextMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const capOf = (a) => (Number.isFinite(a?.capUsd) && a.capUsd > 0 ? a.capUsd : 1);

export function createAutomationService({
  store, runner, budget, history, schedule, permissions, worktree, skills, writeGuardRules,
  inflight, mkdir, notify = () => {}, commandsOf = async () => ({}), removeWorktree = async () => {},
  guardEnabled = () => true, baseEnv = () => ({}), log = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let items = [];
  let readError = null;
  let started = false;
  let stopped = false;
  let timer = null;
  let budgetPausedDay = null; // the day the queue hit the daily cap
  const floor = new Map(); // id → instant up to which slots were already handled
  const last = new Map(); // id → newest history entry
  const queue = []; // [{ id, late }]
  const running = new Map(); // id → { id, name, root, startedAt, late, capUsd, denials, cancelRequested }
  const rules = {}; // id → guardRules(...), the regras.json body
  const listeners = new Set();
  let inflightChain = Promise.resolve();

  const emit = () => { for (const fn of listeners) { try { fn(); } catch (error) { log(`automations: listener failed (${error})`); } } };
  const fail = (error) => ({ ok: false, error });
  const find = (id) => items.find((a) => a.id === id) ?? null;
  const isQueued = (id) => queue.some((q) => q.id === id);
  const refresh = async () => { items = await store.list(); };

  // The first slot after the last run (or creation); a slot already handled
  // (skipped, paused through, edited) is pushed past `floor`.
  function nextOf(a) {
    const base = a.lastRun ?? a.createdAt;
    const natural = schedule.nextRun(a.when, { from: base, lastRun: base });
    const f = floor.get(a.id);
    if (f == null || (natural != null && natural > f)) return natural;
    return schedule.nextRun(a.when, { from: f, lastRun: f });
  }
  const schedulable = (a) => !a.paused && !a.blockedUntilConfirm && !running.has(a.id) && !isQueued(a.id);

  // What to do about `a` at `at`: nothing yet, run on time, run late (a missed
  // slot within the grace), or skip the missed slot.
  function dueAction(a, at) {
    const next = nextOf(a);
    if (next == null || next > at) return null;
    if (at - next <= LATE_TOLERANCE_MS) return 'run';
    const base = Math.max(a.lastRun ?? a.createdAt, floor.get(a.id) ?? -Infinity);
    const missed = schedule.missedRun(a.when, { lastRun: base, createdAt: a.createdAt, now: at });
    return a.missed === 'run' && missed != null ? 'late' : 'skip';
  }

  function collectDue() {
    const at = now();
    for (const a of items) {
      if (!schedulable(a)) continue;
      const action = dueAction(a, at);
      if (action === 'skip') floor.set(a.id, at);
      else if (action) queue.push({ id: a.id, late: action === 'late' });
    }
  }

  function arm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (stopped || !started) return;
    const at = now();
    let wake = null;
    for (const a of items) {
      if (!schedulable(a)) continue;
      const next = nextOf(a);
      if (next != null && (wake === null || next < wake)) wake = next;
    }
    // A queue held by the daily cap waits for the next day.
    if (budgetPausedDay && queue.length) wake = wake === null ? nextMidnight(at) : Math.min(wake, nextMidnight(at));
    if (wake === null) return;
    timer = setTimer(tick, Math.min(Math.max(wake - at, 0), MAX_SLEEP_MS));
  }

  function tick() {
    timer = null;
    if (stopped) return;
    collectDue();
    drain();
    arm();
    emit();
  }

  function drain() {
    if (stopped) return;
    if (budgetPausedDay && budgetPausedDay !== dayKey(now())) budgetPausedDay = null;
    while (running.size < MAX_RUNNING) {
      const busy = new Set([...running.values()].map((r) => r.root));
      const index = queue.findIndex((q) => { const a = find(q.id); return a && !busy.has(a.projectRoot); });
      if (index < 0) break;
      const a = find(queue[index].id);
      if (!budget.allows(capOf(a))) {
        if (!budgetPausedDay) {
          budgetPausedDay = dayKey(now());
          notify({ status: 'day-cap', name: null, text: DAY_CAP_NOTICE });
        }
        break;
      }
      budgetPausedDay = null;
      const [entry] = queue.splice(index, 1);
      execute(a, entry.late).catch((error) => log(`automations: run ${a.id} crashed (${error?.stack ?? error})`));
    }
  }

  // The runs in flight, on disk: a quit or crash that never wrote their
  // history leaves them here for the next start to record as cancelled.
  function saveInflight() {
    const list = [...running.values()].filter((r) => r.recorded).map(({ id, name, startedAt, late, capUsd }) => ({ id, name, startedAt, late, capUsd }));
    inflightChain = inflightChain.then(() => inflight.write(list)).catch((error) => log(`automations: inflight write failed (${error})`));
    return inflightChain;
  }

  // One write at a time, each with the rules as they are when its turn comes:
  // two runs starting together must not race on the same file.
  let rulesChain = Promise.resolve();
  function writeRules() {
    const write = rulesChain.then(() => writeGuardRules({ version: 1, automations: structuredClone(rules) }));
    rulesChain = write.catch(() => {});
    return write;
  }
  async function rulesAtRest(a) {
    // The worktree path is only known once a run prepares it: until then that
    // level's entry fails closed (no edits).
    const cmds = await commandsOf(a.projectRoot).catch(() => ({}));
    rules[a.id] = permissions.guardRules(a, { worktreePath: a.level === 'project' ? a.projectRoot : undefined, ...cmds });
  }

  async function perform(a, r) {
    if (EDIT_LEVELS.has(a.level) && !guardEnabled()) return { status: 'failed', reason: GUARD_OFF };
    const patched = await store.patch(a.id, { lastRun: r.startedAt }).catch((error) => ({ ok: false, error: String(error) }));
    if (!patched.ok) log(`automations: could not save lastRun for ${a.id} (${patched.error})`);
    r.recorded = true;
    await saveInflight();
    const cmds = await commandsOf(a.projectRoot).catch(() => ({}));
    try {
      await skills.write(a);
    } catch (error) {
      log(`automations: skill write failed for ${a.id} (${error})`);
      return { status: 'failed', reason: 'Não deu pra gravar a skill da automação.' };
    }
    let cwd = a.projectRoot;
    let worktreePath = a.level === 'project' ? a.projectRoot : undefined;
    let branch;
    if (a.level === 'worktree') {
      const prepared = await worktree.prepare(a);
      if (!prepared?.ok) return { status: 'failed', reason: prepared?.reason ?? 'Não consegui preparar a worktree da automação.' };
      ({ path: cwd, branch } = prepared);
      worktreePath = prepared.path;
    }
    if (r.cancelRequested) return { status: 'cancelled', branch };
    rules[a.id] = permissions.guardRules(a, { worktreePath, ...cmds });
    try {
      await writeRules();
    } catch (error) {
      log(`automations: guard rules write failed (${error})`);
      return { status: 'failed', branch, reason: 'Não deu pra gravar as regras da trava; a automação não rodou pra não ficar sem freio.' };
    }
    const args = permissions.cliArgs(a, cmds);
    const env = permissions.runEnv(a, baseEnv());
    if (env.GH_CONFIG_DIR) {
      try {
        await mkdir(env.GH_CONFIG_DIR, { recursive: true });
      } catch (error) {
        log(`automations: gh-empty mkdir failed (${error})`);
        return { status: 'failed', branch, reason: 'Não deu pra preparar o isolamento do gh da automação.' };
      }
    }
    if (r.cancelRequested) return { status: 'cancelled', branch };
    const result = await runner.run({ automation: a, args, cwd, env, timeoutMs: a.timeoutMin * 60000 });
    if (result.status === 'failed' && result.stderr) log(`automations: ${a.id} failed: ${String(result.stderr).slice(0, 300)}`);
    return { ...result, branch, reason: result.status === 'failed' ? 'O claude terminou com erro.' : undefined };
  }

  async function execute(a, late) {
    const r = { id: a.id, name: a.name, root: a.projectRoot, startedAt: now(), late, capUsd: capOf(a), denials: 0, cancelRequested: false, recorded: false };
    running.set(a.id, r);
    // Even if lastRun cannot be saved, this slot is handled.
    floor.set(a.id, r.startedAt);
    emit();
    let outcome;
    try {
      outcome = await perform(a, r);
    } catch (error) {
      log(`automations: run ${a.id} threw (${error?.stack ?? error})`);
      outcome = { status: 'failed', reason: 'Erro inesperado ao rodar a automação.' };
    }
    await finish(a, r, outcome);
  }

  async function finish(a, r, outcome) {
    let status = outcome.status;
    // The guard's denials never reach the CLI's permission_denials: the guard tells the Vizor.
    if ((status === 'ok' || status === 'failed') && r.denials > 0) status = 'blocked';
    budget.add(outcome.costUsd ?? 0);
    if (BLOCKING.has(status)) {
      await store.patch(a.id, { blockedUntilConfirm: true }).catch((error) => log(`automations: could not block ${a.id} (${error})`));
    }
    const entry = {
      name: a.name, status, costUsd: outcome.costUsd ?? 0, durationMs: outcome.durationMs ?? now() - r.startedAt,
      numTurns: outcome.numTurns, sessionId: outcome.sessionId ?? undefined, permissionDenials: outcome.permissionDenials,
      late: r.late, branch: outcome.branch, reason: outcome.reason ?? (r.denials ? `A trava barrou ${r.denials} passo(s).` : undefined),
      // An empty result lets the report show the reason instead.
      result: outcome.result || undefined,
    };
    try {
      last.set(a.id, await history.append(a.id, entry));
    } catch (error) {
      log(`automations: history append failed for ${a.id} (${error})`);
    }
    running.delete(a.id);
    await saveInflight();
    if (NOTICE[status]) notify({ status, name: a.name, id: a.id, text: NOTICE[status](a.name) });
    await refresh().catch((error) => log(`automations: list failed (${error})`));
    drain();
    arm();
    emit();
  }

  return {
    on(event, fn) { if (event === 'changed') listeners.add(fn); return () => listeners.delete(fn); },

    async start() {
      if (started) return;
      readError = (await store.readError?.()) ? READ_ERROR : null;
      await refresh();
      // Runs a quit or crash cut short: recorded as cancelled, their cap counted.
      const leftovers = await inflight.read().catch(() => []);
      for (const run of Array.isArray(leftovers) ? leftovers : []) {
        if (typeof run?.id !== 'string') continue;
        budget.add(Number(run.capUsd) || 0);
        await history.append(run.id, { name: run.name, status: 'cancelled', costUsd: Number(run.capUsd) || 0, late: Boolean(run.late), reason: 'O Vizor fechou no meio da execução.' })
          .catch((error) => log(`automations: history append failed (${error})`));
      }
      if (leftovers?.length) await inflight.write([]).catch((error) => log(`automations: inflight clear failed (${error})`));
      for (const a of items) {
        await rulesAtRest(a);
        const [entry] = await history.list(a.id, { limit: 1 }).catch(() => []);
        if (entry) last.set(a.id, entry);
      }
      await writeRules().catch((error) => log(`automations: guard rules write failed (${error})`));
      started = true;
      collectDue();
      drain();
      arm();
      emit();
    },

    async save(input) {
      if (readError) return fail(READ_ERROR);
      if (!input || typeof input !== 'object') return fail('Automação inválida.');
      const existing = input.id != null ? find(input.id) : null;
      if (input.id != null && !existing) return fail('Automação não encontrada.');
      if (existing && (running.has(existing.id) || isQueued(existing.id))) return fail('Espere a execução terminar (ou cancele) antes de editar.');
      const editable = Object.fromEntries(EDITABLE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
      const merged = existing ? { ...existing, ...editable } : editable;
      if (EDIT_LEVELS.has(merged.level) && !guardEnabled()) return fail(GUARD_OFF);
      let result;
      try {
        result = await store.save(merged);
      } catch (error) {
        log(`automations: save failed (${error})`);
        return fail('Não deu pra gravar a automação.');
      }
      if (!result.ok) return result;
      const a = result.automation;
      try {
        await skills.write(a);
      } catch (error) {
        log(`automations: skill write failed (${error})`);
        // Back to what was there: an automação without its skill would run nothing.
        await (existing ? store.save(existing) : store.remove(a.id)).catch((e) => log(`automations: rollback failed (${e})`));
        await refresh();
        return fail('Não deu pra gravar a skill da automação; nada mudou.');
      }
      if (existing && (existing.skillScope !== a.skillScope || existing.projectRoot !== a.projectRoot)) {
        await skills.remove(existing).catch((error) => log(`automations: old skill removal failed (${error})`));
      }
      await refresh();
      floor.set(a.id, now());
      await rulesAtRest(a);
      await writeRules().catch((error) => log(`automations: guard rules write failed (${error})`));
      arm();
      emit();
      return { ok: true, automation: a };
    },

    async remove(id, { removeSkill = false, removeWorktree: dropWorktree = false } = {}) {
      if (readError) return fail(READ_ERROR);
      const a = find(id);
      if (!a) return fail('Automação não encontrada.');
      if (running.has(id)) return fail('Cancele a execução antes de apagar.');
      const index = queue.findIndex((q) => q.id === id);
      if (index >= 0) queue.splice(index, 1);
      try {
        await store.remove(id);
      } catch (error) {
        log(`automations: remove failed (${error})`);
        return fail('Não deu pra apagar a automação.');
      }
      const warnings = [];
      if (removeSkill) {
        try {
          const removed = await skills.remove(a);
          if (removed?.warning) warnings.push(removed.warning);
        } catch (error) {
          warnings.push('Não deu pra apagar a skill.');
          log(`automations: skill removal failed (${error})`);
        }
      }
      if (dropWorktree && a.level === 'worktree') {
        try {
          await removeWorktree(a);
        } catch (error) {
          warnings.push('Não deu pra remover a worktree (ela tem mudanças?).');
          log(`automations: worktree removal failed (${error})`);
        }
      }
      delete rules[id];
      await writeRules().catch((error) => log(`automations: guard rules write failed (${error})`));
      floor.delete(id);
      last.delete(id);
      await refresh();
      arm();
      emit();
      return { ok: true, warnings };
    },

    async runNow(id) {
      if (stopped) return fail('O Vizor está fechando.');
      const a = find(id);
      if (!a) return fail('Automação não encontrada.');
      if (a.blockedUntilConfirm) return fail('Esta automação passou do teto ou do tempo: confirme antes de rodar de novo.');
      if (running.has(id)) return fail('Ela já está rodando.');
      if (isQueued(id)) return fail('Ela já está na fila.');
      queue.push({ id, late: false });
      drain();
      arm();
      emit();
      return { ok: true, queued: !running.has(id) };
    },

    async pause(id, on) {
      const result = await store.patch(id, { paused: Boolean(on) }).catch(() => fail('Não deu pra gravar a pausa.'));
      if (!result.ok) return result;
      if (on) { const index = queue.findIndex((q) => q.id === id); if (index >= 0) queue.splice(index, 1); }
      // Slots that passed while paused are not caught up.
      else floor.set(id, now());
      await refresh();
      arm();
      emit();
      return { ok: true };
    },

    async confirm(id) {
      const result = await store.patch(id, { blockedUntilConfirm: false }).catch(() => fail('Não deu pra gravar a confirmação.'));
      if (!result.ok) return result;
      floor.set(id, now());
      await refresh();
      arm();
      emit();
      return { ok: true };
    },

    async cancel(id) {
      const index = queue.findIndex((q) => q.id === id);
      if (index >= 0) {
        queue.splice(index, 1);
        arm();
        emit();
        return true;
      }
      const r = running.get(id);
      if (!r) return false;
      r.cancelRequested = true;
      runner.cancel(id);
      return true;
    },

    // A guard-event with this automação's id: the guard denied one of its steps.
    noteGuardDenial(id) {
      const r = running.get(id);
      if (r) r.denials++;
    },

    // Clean quit: nothing new starts, every run is cancelled and settles as
    // 'cancelled' through the normal path.
    shutdown() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue.length = 0;
      for (const r of running.values()) r.cancelRequested = true;
      return runner.cancelAll();
    },
    // Synchronous and final (process 'exit'): the inflight file speaks for the runs.
    killAllNow() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      runner.killAllNow();
    },
    // After a resume from suspend: recheck the clock now.
    wake() { if (started && !stopped) tick(); },

    count: () => items.length,
    state() {
      const at = now();
      const list = items.map((a) => {
        const r = running.get(a.id);
        const queued = isQueued(a.id);
        return {
          ...a,
          describe: schedule.describeWhen(a.when),
          next: schedulable(a) ? nextOf(a) : null,
          last: last.get(a.id) ?? null,
          running: r ? { startedAt: r.startedAt, late: r.late } : null,
          queued,
        };
      });
      const nexts = list.map((a) => a.next).filter((n) => n != null);
      const spent = budget.spent();
      return {
        list,
        budget: { spent, cap: budget.capUsd, paused: Boolean(budgetPausedDay && budgetPausedDay === dayKey(at)) || spent >= budget.capUsd },
        nextAt: nexts.length ? Math.min(...nexts) : null,
        readError,
      };
    },
  };
}

// The kanban's cards for running automações: a separate list beside the
// chats' sessionCard. Pure (no node: imports) so the renderer can load it too.
export function automationRunCards(list, guardAsks = []) {
  const asking = new Set((guardAsks ?? []).map((ask) => ask?.automationId).filter(Boolean));
  return (list ?? []).filter((a) => a.running).map((a) => {
    const waiting = asking.has(a.id);
    return {
      id: `automation:${a.id}`,
      automationId: a.id,
      column: waiting ? 'waiting' : 'working',
      title: a.name,
      projectRoot: a.projectRoot,
      avatarKey: a.projectRoot,
      since: a.running.startedAt,
      late: Boolean(a.running.late),
      waiting,
      badge: 'automação',
    };
  });
}
