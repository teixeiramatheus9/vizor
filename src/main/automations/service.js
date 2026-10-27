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
const DAY_MS = 24 * 3600000;

export const DAY_CAP_RANGE = { min: 0.5, max: 100 };
export const READ_ERROR = 'não deu pra ler as automações; nada foi gravado pra não perder o que existe';
const GUARD_NOT_READY = 'A trava ainda não está instalada no Claude Code; a automação não rodou pra não ficar sem freio. Tente de novo em instantes.';
const GUARD_OFF = 'A trava está desligada: assim, só o nível "Ler e relatar" pode ser usado. Ligue a trava pra editar numa worktree ou no projeto.';

const NOTICE = {
  ok: (name) => `a automação ${name} terminou`,
  failed: (name) => `a automação ${name} falhou`,
  blocked: (name) => `a automação ${name} foi barrada pela trava`,
  'over-cap': (name) => `a automação ${name} passou do teto`,
  timeout: (name) => `a automação ${name} passou do tempo`,
};
const DAY_CAP_NOTICE = 'as automações passaram do teto do dia e pausaram até amanhã';
// A run capped above the whole day's cap could never start: it is set aside, not left holding the queue.
const CAP_OVER_DAY = 'teto da execução maior que o teto do dia';

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const nextMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };
const capOf = (a) => (Number.isFinite(a?.capUsd) && a.capUsd > 0 ? a.capUsd : 1);
const money = (usd) => `US$ ${usd.toFixed(2).replace('.', ',')}`;

export function createAutomationService({
  store, runner, budget, history, schedule, permissions, worktree, skills, writeGuardRules,
  inflight, mkdir, notify = () => {}, commandsOf = async () => ({}), removeWorktree = async () => {},
  saveDayCap = async () => {}, guardEnabled = () => true, guardReady = () => true, baseEnv = () => ({}), log = () => {},
  // A crash leaves the detached claude group alive: the next start kills it.
  kill = () => {}, readCmdline = () => '',
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let items = [];
  let readError = null;
  let loaded = false;
  let started = false;
  let stopped = false;
  let timer = null;
  let budgetPausedDay = null; // the day the queue hit the daily cap
  const floor = new Map(); // id → instant up to which slots were already handled
  const last = new Map(); // id → newest history entry
  const queue = []; // [{ id, late, slot, manual, held }]
  // Every execute() in flight: a quit waits for their history writes, not just for the processes to die.
  const executions = new Set();
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
  const overDayCap = (a) => capOf(a) > budget.capUsd + 1e-9;
  const schedulable = (a) => !a.paused && !a.blockedUntilConfirm && !overDayCap(a) && !running.has(a.id) && !isQueued(a.id);
  // The one way into the queue: an automação already queued or running is
  // refused, so no entry point can start one slot twice.
  function enqueue(entry) {
    if (running.has(entry.id) || isQueued(entry.id)) {
      log(`automations: refused to queue ${entry.id} twice`);
      return false;
    }
    queue.push(entry);
    return true;
  }

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

  const lateSlot = (a, at) => schedule.missedRun(a.when, { lastRun: Math.max(a.lastRun ?? a.createdAt, floor.get(a.id) ?? -Infinity), createdAt: a.createdAt, now: at });

  // A new day after the daily cap held the queue: a held slot whose next
  // regular slot comes within a day of it is left to that slot (no 00:00 run
  // and another at 08:00); the others run once, late. A manual run stays.
  function releaseHeld(at) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (!q.held) continue;
      q.held = false;
      if (q.manual) { q.late = true; continue; }
      const a = find(q.id);
      const regular = a ? schedule.nextRun(a.when, { from: at, lastRun: at }) : null;
      if (!a || a.missed === 'skip' || (regular != null && regular <= q.slot + DAY_MS)) {
        queue.splice(i, 1);
        floor.set(q.id, at);
      } else {
        q.late = true;
      }
    }
  }

  function collectDue() {
    const at = now();
    for (const a of items) {
      if (!schedulable(a)) continue;
      const action = dueAction(a, at);
      if (action === 'skip') floor.set(a.id, at);
      else if (action === 'late') enqueue({ id: a.id, late: true, slot: lateSlot(a, at) ?? at });
      else if (action) enqueue({ id: a.id, late: false, slot: nextOf(a) });
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
    if (budgetPausedDay && budgetPausedDay !== dayKey(now())) {
      budgetPausedDay = null;
      releaseHeld(now());
    }
    // Queued before the day cap dropped under its own cap: its slot is handled, the others go on.
    for (let i = queue.length - 1; i >= 0; i--) {
      const a = find(queue[i].id);
      if (!a || !overDayCap(a)) continue;
      const [entry] = queue.splice(i, 1);
      if (!entry.manual) floor.set(entry.id, now());
      log(`automations: ${entry.id} set aside, its cap is above the day cap`);
    }
    while (running.size < MAX_RUNNING) {
      const busy = new Set([...running.values()].map((r) => r.root));
      const index = queue.findIndex((q) => { const a = find(q.id); return a && !busy.has(a.projectRoot); });
      if (index < 0) break;
      const a = find(queue[index].id);
      // The caps of the runs in flight are spoken for: two runs starting
      // together must not take the day past its cap.
      const reserved = [...running.values()].reduce((sum, r) => sum + r.capUsd, 0);
      // Only waiting for a run in flight to settle what it really spent.
      if (budget.allows(capOf(a)) && !budget.allows(capOf(a) + reserved)) break;
      if (!budget.allows(capOf(a))) {
        for (const q of queue) q.held = true;
        if (!budgetPausedDay) {
          budgetPausedDay = dayKey(now());
          notify({ status: 'day-cap', name: null, text: DAY_CAP_NOTICE });
        }
        break;
      }
      budgetPausedDay = null;
      const [entry] = queue.splice(index, 1);
      const settled = execute(a, entry.late)
        .catch((error) => log(`automations: run ${a.id} crashed (${error?.stack ?? error})`))
        .finally(() => executions.delete(settled));
      executions.add(settled);
    }
  }

  // The runs in flight, on disk: a quit or crash that never wrote their
  // history leaves them here for the next start to record as cancelled.
  function saveInflight() {
    const list = [...running.values()].filter((r) => r.recorded).map(({ id, name, startedAt, late, capUsd, pgid }) => ({ id, name, startedAt, late, capUsd, pgid }));
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
    // The CLI flags alone are not enough for a level that edits: the hook must be in place.
    if (EDIT_LEVELS.has(a.level) && !guardReady()) return { status: 'failed', reason: GUARD_NOT_READY };
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
    const onSpawn = (pgid) => {
      r.pgid = pgid;
      saveInflight();
    };
    const result = await runner.run({ automation: a, args, cwd, env, timeoutMs: a.timeoutMin * 60000, onSpawn });
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
    // Off the inflight file first: a quit between the two loses the entry
    // rather than recording (and charging) the run twice.
    r.recorded = false;
    await saveInflight();
    try {
      last.set(a.id, await history.append(a.id, entry));
    } catch (error) {
      log(`automations: history append failed for ${a.id} (${error})`);
    }
    running.delete(a.id);
    if (NOTICE[status]) notify({ status, name: a.name, id: a.id, text: NOTICE[status](a.name) });
    await refresh().catch((error) => log(`automations: list failed (${error})`));
    drain();
    arm();
    emit();
  }

  // A pgid is only killed while its leader is still a claude: the pid may
  // have been handed to something else since.
  function killLeftover(pgid) {
    if (!Number.isInteger(pgid) || pgid <= 1) return;
    try {
      if (!String(readCmdline(pgid) ?? '').includes('claude')) return;
      kill(-pgid, 'SIGKILL');
      log(`automations: killed the leftover run group ${pgid}`);
    } catch {
      // gone already, or not ours to kill
    }
  }

  return {
    on(event, fn) { if (event === 'changed') listeners.add(fn); return () => listeners.delete(fn); },

    // Reads the automações (and settles leftovers) without scheduling, so the
    // caller can install the guard hook before anything runs.
    async load() {
      if (loaded) return;
      loaded = true;
      readError = (await store.readError?.()) ? READ_ERROR : null;
      await refresh();
      // Runs a quit or crash cut short: recorded as cancelled, their cap counted.
      const leftovers = await inflight.read().catch(() => []);
      for (const run of Array.isArray(leftovers) ? leftovers : []) {
        if (typeof run?.id !== 'string') continue;
        killLeftover(run.pgid);
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
    },

    async start() {
      if (started) return;
      await this.load();
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
      const cap = merged.capUsd === undefined ? 1 : merged.capUsd;
      if (typeof cap === 'number' && cap > budget.capUsd + 1e-9) return fail(`O teto da execução não pode passar do teto do dia (${money(budget.capUsd)}).`);
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
      if (overDayCap(a)) return fail(`Bloqueada: ${CAP_OVER_DAY}.`);
      if (running.has(id)) return fail('Ela já está rodando.');
      if (isQueued(id)) return fail('Ela já está na fila.');
      enqueue({ id, late: false, slot: now(), manual: true });
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

    // The tab's "subir teto": the day cap, validated and kept in the config.
    async setDayCap(value) {
      const usd = typeof value === 'number' ? Math.round(value * 100) / 100 : NaN;
      if (!Number.isFinite(usd) || usd < DAY_CAP_RANGE.min || usd > DAY_CAP_RANGE.max) return fail('O teto do dia deve ficar entre US$ 0,50 e US$ 100.');
      try {
        await saveDayCap(usd);
      } catch (error) {
        log(`automations: day cap save failed (${error})`);
        return fail('Não deu pra gravar o teto do dia.');
      }
      const wasOver = items.filter(overDayCap);
      budget.setCap(usd);
      // Back under the cap: on schedule from now, the slots it sat out not caught up.
      for (const a of wasOver) if (!overDayCap(a)) floor.set(a.id, now());
      // Runs held by the old cap get their turn now.
      budgetPausedDay = null;
      drain();
      arm();
      emit();
      return { ok: true, cap: usd };
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
        const [entry] = queue.splice(index, 1);
        // A cancelled slot is handled: the next tick must not queue it again.
        if (!entry.manual) floor.set(id, now());
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
      return runner.cancelAll().then(() => Promise.all([...executions]));
    },
    // Synchronous and final (process 'exit'): the inflight file speaks for the runs.
    killAllNow() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      runner.killAllNow();
    },
    // After a resume from suspend: recheck the clock now.
    wake() {
      if (!started || stopped) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      tick();
    },
    // The quit did not go through: schedule again.
    resume() {
      if (!stopped) return;
      stopped = false;
      arm();
      emit();
    },

    count: () => items.length,
    nameOf: (id) => find(id)?.name ?? null,
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
          capBlocked: overDayCap(a) ? CAP_OVER_DAY : null,
        };
      });
      const nexts = list.map((a) => a.next).filter((n) => n != null);
      const spent = budget.spent();
      return {
        list,
        budget: { spent, cap: budget.capUsd, paused: Boolean(budgetPausedDay && budgetPausedDay === dayKey(at)) || spent >= budget.capUsd },
        nextAt: nexts.length ? Math.min(...nexts) : null,
        readError,
        // The tab disables the levels that edit while the guard is off.
        guardEnabled: guardEnabled(),
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
