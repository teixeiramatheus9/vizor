// The task flow of an issue's chat: contract → tests → steps → PR. It binds
// chats to tasks, writes the guard's task rules (tarefas/regras.json), takes a
// checkpoint per ticked step, runs the approved contract command, checks the
// locked tests' hashes on Stop and expires idle tasks. The pure transitions
// live in task-state.js; every IO is injected.
import path from 'node:path';
import { findDevTodos, parseTaskPlan } from './contract.js';
import { planFileName } from './plan.js';
import {
  APPROVE_PROMPT, CONTRACT_APPROVED_PROMPT, DEV_DONE_PROMPT, NEXT_STEP_PROMPT, TRUST_PROMPT,
  devStepPrompt, restoredPrompt, undoStepPrompt,
} from './prompts.js';
import * as T from './task-state.js';

const NO_TASK = 'Esse chat não tem tarefa.';
const MAX_COMMENT = 4000;
const MAX_TODOS = 20;
const TAIL_MAX = 8192;
const DIFF_MAX = 8000;
// The blob-to-blob header names object ids, not the file: the card shows only the hunks.
const DIFF_HEADER = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode )/;
const hunksOf = (patch) => {
  const lines = String(patch).split('\n');
  let start = 0;
  while (start < lines.length && DIFF_HEADER.test(lines[start])) start++;
  const text = lines.slice(start).join('\n');
  return text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n… (cortado)` : text;
};
const MAX_DELAY = 2 ** 31 - 1; // setTimeout's own limit
const GATED = new Set(['contract', 'tests', 'steps', 'pr']);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const validBinding = (sessionId, worktree, issue) =>
  typeof sessionId === 'string' && sessionId !== '' && typeof worktree === 'string' && path.isAbsolute(worktree) && Number.isInteger(issue) && issue > 0;

// What git grep prints: file:line:text.
function parseTodoGrep(out, limit = MAX_TODOS) {
  const todos = [];
  for (const line of String(out ?? '').split('\n')) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    const found = match && findDevTodos(match[3])[0];
    if (found) todos.push({ file: match[1], line: Number(match[2]), note: found.note });
    if (todos.length === limit) break;
  }
  return todos;
}

export function createTaskService({
  store, checkpoints, verifier, writeGuardRules, sha256File, deliver, now = Date.now, git, notify = () => {},
  readPlan = async () => null, isWorking = () => false, issueClosed = async () => false, changed = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
}) {
  const tasks = new Map(); // key → { key, worktree, issue, state, plan, saved, running, waitUntick, chain }
  const loading = new Map(); // key → Promise<task>
  const bySession = new Map(); // sessionId → key
  let rulesChain = Promise.resolve();
  let rulesWritten = null;
  let expiryTimer = null;

  // One operation at a time per task: plan reads, actions and run results share its state.
  function serial(task, fn) {
    const result = task.chain.then(fn);
    task.chain = result.catch(() => {});
    return result;
  }

  async function ensure(worktree, issue) {
    const key = T.taskKey(worktree, issue);
    if (tasks.has(key)) return tasks.get(key);
    if (!loading.has(key)) {
      loading.set(key, (async () => {
        const state = await store.load(key);
        const task = { key, worktree, issue, state: { ...state, worktree, issue }, plan: null, saved: state.updatedAt > 0, running: 0, generation: 0, chain: Promise.resolve() };
        for (const sessionId of task.state.sessions) bySession.set(sessionId, key);
        tasks.set(key, task);
        loading.delete(key);
        return task;
      })());
    }
    return loading.get(key);
  }

  const taskOf = (sessionId) => tasks.get(bySession.get(sessionId)) ?? null;
  const planPath = (task) => path.join(task.worktree, planFileName(task.issue));
  const abs = (task, file) => path.join(task.worktree, file);

  function phaseOf(task) {
    if (task.state.ended || task.state.quick || !task.plan) return 'quick';
    return T.nextPhase(task.state, task.plan);
  }

  async function persist(task) {
    if (tasks.get(task.key) !== task) return; // dropped meanwhile: nothing to keep
    const worth = task.saved || task.plan || task.state.contract || task.state.tests;
    if (!worth) return;
    task.state = { ...task.state, updatedAt: now() };
    await store.save(task.key, task.state);
    task.saved = true;
  }

  // The guard's view: the phase of each bound chat, and the locked tests per folder.
  function rulesDoc() {
    const sessions = {};
    const folders = {};
    for (const task of tasks.values()) {
      if (task.state.ended) continue;
      const phase = phaseOf(task);
      if (GATED.has(phase)) {
        const allowEdits = phase === 'tests' ? (task.plan.contractFiles ?? []).map((file) => abs(task, file)) : [];
        for (const sessionId of task.state.sessions) sessions[sessionId] = { phase, allowEdits, planFile: planPath(task) };
      }
      if (task.state.tests) {
        const folder = (folders[task.worktree] ??= { locked: [] });
        for (const [file, sha256] of Object.entries(task.state.tests.hashes)) folder.locked.push({ path: abs(task, file), sha256 });
      }
    }
    return { version: 1, sessions, folders };
  }

  function writeRules() {
    rulesChain = rulesChain.then(async () => {
      const doc = rulesDoc();
      const text = JSON.stringify(doc);
      if (text === rulesWritten) return;
      try {
        await writeGuardRules(doc);
        rulesWritten = text;
      } catch (error) {
        log(`tasks: could not write the guard rules (${error?.message ?? error})`);
      }
    });
    return rulesChain;
  }

  const hasActive = () => {
    const doc = rulesDoc();
    return Object.keys(doc.sessions).length > 0 || Object.keys(doc.folders).length > 0;
  };

  function attach(task, sessionId) {
    const previous = taskOf(sessionId);
    if (previous && previous !== task) {
      previous.state = { ...previous.state, sessions: previous.state.sessions.filter((id) => id !== sessionId) };
      serial(previous, () => persist(previous)).catch((error) => log(`tasks: save failed (${error?.message ?? error})`));
    }
    bySession.set(sessionId, task.key);
    if (!task.state.sessions.includes(sessionId)) task.state = { ...task.state, sessions: [...task.state.sessions, sessionId] };
  }

  // A step undone loses its checkpoint (a new tick takes a new one); a new
  // tick in a contract task takes one. Returns whether a step was ticked.
  async function takeCheckpoints(task) {
    const steps = task.plan?.steps ?? [];
    let ticked = false;
    let next = task.state.checkpoints;
    let waiting = task.state.waitUntick;
    for (const [index, step] of steps.entries()) {
      const n = index + 1;
      if (!step.done) {
        waiting = waiting.filter((item) => item !== n);
        if (next[n]) {
          const { [n]: _gone, ...rest } = next;
          next = rest;
        }
        continue;
      }
      if (next[n] || waiting.includes(n)) continue;
      ticked = true;
      try {
        const { ref } = await checkpoints.take(task.worktree, task.issue, n);
        next = { ...next, [n]: ref };
      } catch (error) {
        log(`tasks: checkpoint ${task.issue}/${n} failed (${error?.message ?? error})`);
      }
    }
    task.state = { ...task.state, checkpoints: next, waitUntick: waiting };
    return ticked;
  }

  // Checkpoint 0: the files before step 1, so step 1 has a diff and a way back.
  async function takeBaseline(task) {
    if (task.state.checkpoints[0]) return;
    try {
      const { ref } = await checkpoints.take(task.worktree, task.issue, 0);
      task.state = { ...task.state, checkpoints: { ...task.state.checkpoints, 0: ref } };
    } catch (error) {
      log(`tasks: baseline checkpoint of #${task.issue} failed (${error?.message ?? error})`);
    }
  }

  const contractPlan = (command) => ({ command: 'nice', args: ['-n', '10', 'sh', '-c', command] });

  async function runContract(task) {
    const command = task.state.tests?.command;
    if (!command) return null;
    const generation = task.generation;
    task.running++;
    changed();
    let result;
    try {
      result = await verifier.run(task.worktree, 'contract', contractPlan(command));
    } finally {
      task.running--;
    }
    if (result.status === 'cancelled') return result; // a newer run owns the result
    await serial(task, async () => {
      // Ended, reopened or dropped while it ran: the result belongs to no task.
      if (tasks.get(task.key) !== task || task.generation !== generation || task.state.ended) return;
      task.state = { ...task.state, lastRun: { status: result.status, tail: String(result.tail ?? result.reason ?? '').slice(-TAIL_MAX), at: now(), ms: result.ms ?? 0 } };
      await persist(task);
    });
    changed();
    return result;
  }

  async function settle() {
    await writeRules();
    schedule();
    changed();
  }

  // The plan as the chat left it: the binding, the phase, the checkpoints and the run.
  async function onPlan(sessionId, worktree, issue, plan) {
    if (!validBinding(sessionId, worktree, issue)) return null;
    const task = await ensure(worktree, issue);
    const run = await serial(task, async () => {
      if (task.state.ended) return false; // ended by the dev: only starting the issue again revives it
      attach(task, sessionId);
      task.plan = plan ?? null;
      // A quick plan is followed once the dev approved it (its baseline exists).
      const contractTask = !task.state.quick && Array.isArray(task.plan?.contract);
      const ticked = contractTask || task.state.checkpoints[0] ? await takeCheckpoints(task) : false;
      const runs = contractTask && ticked;
      await persist(task);
      return runs && ['steps', 'pr'].includes(phaseOf(task));
    });
    await settle();
    if (run) await runContract(task);
    return phaseOf(task);
  }

  async function readParsed(worktree, issue) {
    let text = null;
    try {
      text = await readPlan(worktree, issue);
    } catch {
      // gone or unreadable: no plan
    }
    return text == null ? null : parseTaskPlan(text);
  }

  // The Vizor opened or resumed the issue's chat, or the chat wrote its plan.
  async function bind(sessionId, worktree, issue) {
    if (!validBinding(sessionId, worktree, issue)) return null;
    return onPlan(sessionId, worktree, issue, await readParsed(worktree, issue));
  }

  // Locked tests, checked against their approved hashes.
  async function checkLocks(task) {
    if (!task.state.tests) return false;
    const changedFiles = [];
    for (const [file, sha256] of Object.entries(task.state.tests.hashes)) {
      let current = null;
      try {
        current = await sha256File(abs(task, file));
      } catch {
        // deleted counts as changed
      }
      if (current !== sha256) changedFiles.push(file);
    }
    const before = task.state.changedLocked;
    if (JSON.stringify(before) === JSON.stringify(changedFiles)) return false;
    task.state = { ...task.state, changedLocked: changedFiles };
    if (changedFiles.some((file) => !before.includes(file))) {
      notify(`#${task.issue}: o teste do contrato mudou (${changedFiles.join(', ')}). A PR fica barrada até destravar pelo card.`, { issue: task.issue, worktree: task.worktree });
    }
    return true;
  }

  const contains = (root, dir) => typeof dir === 'string' && (dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep));

  async function onStop(sessionId, cwd) {
    const own = taskOf(sessionId);
    if (own) await bind(sessionId, own.worktree, own.issue);
    const all = [];
    for (const task of [...tasks.values()].filter((item) => item === own || contains(item.worktree, cwd))) {
      const flagged = await serial(task, async () => {
        const moved = await checkLocks(task);
        if (moved) await persist(task);
        return moved;
      });
      if (flagged) changed();
      all.push(...task.state.changedLocked);
    }
    return { changedLocked: all };
  }

  async function drop(task) {
    tasks.delete(task.key);
    for (const sessionId of task.state.sessions) if (bySession.get(sessionId) === task.key) bySession.delete(sessionId);
    await store.remove(task.key).catch((error) => log(`tasks: could not remove ${task.key} (${error?.message ?? error})`));
    await dropRefs(task);
  }

  const dropRefs = (task) => Promise.resolve()
    .then(() => checkpoints.drop(task.worktree, task.issue))
    .catch((error) => log(`tasks: could not drop the checkpoints of #${task.issue} (${error?.message ?? error})`));

  const freshState = (task, extra = {}) => ({ ...T.newTaskState(), worktree: task.worktree, issue: task.issue, ...extra });

  // Started again by the dev (Ctrl+K, voice, "Puxar"): an ended task begins anew.
  async function reopen(worktree, issue) {
    if (typeof worktree !== 'string' || !path.isAbsolute(worktree) || !Number.isInteger(issue) || issue <= 0) return false;
    const task = await ensure(worktree, issue);
    const revived = await serial(task, async () => {
      if (!task.state.ended) return false;
      task.generation++;
      task.state = freshState(task);
      await persist(task);
      return true;
    });
    if (revived) await settle();
    return revived;
  }

  async function expireDue({ checkClosed }) {
    for (const task of [...tasks.values()]) {
      const closed = checkClosed ? await issueClosed(task.worktree, task.issue).catch(() => false) : false;
      // A tombstone never ages out (a plan write would re-gate the chat): it
      // goes only with its plan file or its issue.
      const over = task.state.ended
        ? closed || (await readParsed(task.worktree, task.issue)) === null
        : T.expire(task.state, { now: now(), issueClosed: closed }) === null;
      if (over) await serial(task, () => drop(task));
    }
  }

  // One timer, for the earliest expiry.
  function schedule() {
    clearTimer(expiryTimer);
    expiryTimer = null;
    const due = [...tasks.values()].filter((task) => task.state.updatedAt > 0 && !task.state.ended).map((task) => task.state.updatedAt + T.EXPIRY_MS);
    if (!due.length) return;
    const delay = Math.min(MAX_DELAY, Math.max(0, Math.min(...due) - now()) + 1000);
    expiryTimer = setTimer(async () => {
      expiryTimer = null;
      try {
        await expireDue({ checkClosed: true });
        await settle();
      } catch (error) {
        log(`tasks: expiry failed (${error?.stack ?? error})`);
      }
    }, delay);
  }

  async function start() {
    for (const { key, state } of await store.list()) {
      const { worktree, issue } = state;
      if (!worktree || !issue || T.taskKey(worktree, issue) !== key) {
        await store.remove(key).catch(() => {});
        continue;
      }
      await ensure(worktree, issue);
    }
    await expireDue({ checkClosed: false });
    for (const task of tasks.values()) {
      if (task.state.ended) continue;
      task.plan = await readParsed(task.worktree, task.issue);
      await serial(task, async () => {
        if (await checkLocks(task)) await persist(task);
      });
    }
    await settle();
    // gh is slow or offline at times: the rules are on disk before it is asked.
    await expireDue({ checkClosed: true });
    await settle();
  }

  // --- the card's actions ----------------------------------------------------
  const failed = (error) => ({ error });
  const inFlight = new Set();

  // A change of state, saved and pushed to the guard; then the order, if any, to the chat.
  async function act(sessionId, name, change) {
    const task = taskOf(sessionId);
    if (!task) return failed(NO_TASK);
    const flight = `${sessionId}:${name}`;
    if (inFlight.has(flight)) return failed('Já estou mandando isso pro chat.');
    inFlight.add(flight);
    try {
      const outcome = await serial(task, async () => {
        const result = await change(task);
        if (result?.error) return result;
        await persist(task);
        return result ?? {};
      });
      if (outcome.error) return outcome;
      await settle();
      const { prompt, ...rest } = outcome;
      if (!prompt) return { ok: true, ...rest };
      return { ok: true, ...rest, delivery: await deliver(sessionId, prompt) };
    } finally {
      inFlight.delete(flight);
    }
  }

  const pendingStep = (task) => (task.plan?.steps ?? []).find((step) => !step.done) ?? null;
  const nextOrder = (task) => {
    if (task.state.mode === 'trust') return TRUST_PROMPT;
    const next = pendingStep(task);
    if (!next) return null;
    return next.dev ? devStepPrompt(next.text) : NEXT_STEP_PROMPT;
  };

  const approveContract = (sessionId) => act(sessionId, 'approveContract', (task) => {
    if (!task.plan || !Array.isArray(task.plan.contract)) return failed('O plano não tem contrato.');
    if (task.plan.error) return failed(task.plan.error);
    if (phaseOf(task) !== 'contract') return failed('O contrato já foi aprovado.');
    task.state = T.approveContract(task.state, task.plan);
    return { prompt: CONTRACT_APPROVED_PROMPT };
  });

  // The run comes first (the dev reads why it fails), then the hashes of what was approved.
  async function approveTests(sessionId) {
    const task = taskOf(sessionId);
    if (!task) return failed(NO_TASK);
    const check = () => {
      if (phaseOf(task) !== 'tests') return 'Os testes não estão esperando aprovação.';
      if (!task.plan.contractFiles?.length) return 'Falta a linha Vizor-contrato com os arquivos de teste no plano.';
      if (!task.plan.testCommand) return 'Falta a linha Vizor-teste com o comando no plano.';
      return null;
    };
    const early = check();
    if (early) return failed(early);
    // A second click while the first one's run is going would cancel it.
    const flight = `${sessionId}:approveTests:run`;
    if (inFlight.has(flight)) return failed('Os testes já estão rodando.');
    inFlight.add(flight);
    try {
      return await approveTestsAfterRun(sessionId, task, check);
    } finally {
      inFlight.delete(flight);
    }
  }

  async function approveTestsAfterRun(sessionId, task, check) {
    const command = task.plan.testCommand;
    const files = task.plan.contractFiles;
    task.running++;
    changed();
    let run;
    try {
      run = await verifier.run(task.worktree, 'contract', contractPlan(command));
    } finally {
      task.running--;
    }
    if (run.status === 'cancelled') return failed('A execução dos testes foi cancelada; tente de novo.');
    return act(sessionId, 'approveTests', async () => {
      const late = check();
      if (late) return failed(late);
      if (task.plan.testCommand !== command || JSON.stringify(task.plan.contractFiles) !== JSON.stringify(files)) {
        return failed('O plano mudou enquanto os testes rodavam; confira e aprove de novo.');
      }
      // Locked already (the command changed): the locked set and its hashes stay.
      let hashes = task.state.tests?.hashes;
      let blobs = task.state.tests?.blobs;
      if (!hashes) {
        hashes = {};
        for (const file of files) {
          try {
            hashes[file] = await sha256File(abs(task, file));
          } catch {
            return failed(`Não achei o arquivo de teste ${file}.`);
          }
        }
        blobs = await approvedBlobs(task, files);
      }
      await takeBaseline(task);
      task.state = {
        ...T.approveTests(task.state, task.plan, hashes, blobs),
        changedLocked: [],
        lastRun: { status: run.status, tail: String(run.tail ?? run.reason ?? '').slice(-TAIL_MAX), at: now(), ms: run.ms ?? 0 },
      };
      return { prompt: nextOrder(task), run: task.state.lastRun };
    });
  }

  // The approved content of each test, kept as a git object: a later change diffs against it.
  async function approvedBlobs(task, files) {
    const blobs = {};
    if (!git) return blobs;
    for (const file of files) {
      try {
        const oid = String(await git(['hash-object', '-w', '--', file], { cwd: task.worktree })).trim();
        if (T.isObjectId(oid)) blobs[file] = oid;
      } catch (error) {
        log(`tasks: could not keep the approved ${file} of #${task.issue} (${error?.message ?? error})`);
      }
    }
    return blobs;
  }

  // What a changed locked test changed since its approval; only asked for flagged files,
  // and cached while neither side moves. null when there is nothing to diff against.
  async function lockDiff(task, file) {
    const approved = task.state.tests?.blobs?.[file];
    if (!git || !approved) return null;
    let current = null;
    try {
      current = await sha256File(abs(task, file));
    } catch {
      // deleted: diffs against the empty file
    }
    const key = `${approved}:${current}`;
    task.lockDiffs ??= new Map();
    const cached = task.lockDiffs.get(file);
    if (cached?.key === key) return cached.text;
    let text = null;
    try {
      const cwd = task.worktree;
      const args = current == null ? ['hash-object', '-w', '-t', 'blob', '/dev/null'] : ['hash-object', '-w', '--', file];
      const oid = String(await git(args, { cwd })).trim();
      if (T.isObjectId(oid)) text = hunksOf(await git(['diff', '--no-color', '-U3', approved, oid], { cwd }));
    } catch (error) {
      log(`tasks: could not diff the locked ${file} of #${task.issue} (${error?.message ?? error})`);
    }
    task.lockDiffs.set(file, { key, text });
    return text;
  }

  const unlockTests = (sessionId) => act(sessionId, 'unlockTests', (task) => {
    if (!task.state.tests) return failed('Os testes não estão travados.');
    task.state = { ...T.unlockTests(task.state), changedLocked: [] };
    return null;
  });

  const doneStep = (task, text) => (task.plan?.steps ?? []).find((step) => step.done && T.stepKey(step.text) === T.stepKey(text));

  const reviewStep = (sessionId, text) => act(sessionId, 'reviewStep', (task) => {
    if (!doneStep(task, text)) return failed('Esse passo não está feito.');
    task.state = T.reviewStep(task.state, text);
    return null;
  });

  const setMode = (sessionId, mode) => act(sessionId, 'setMode', (task) => {
    if (!['step', 'trust'].includes(mode)) return failed('Modo desconhecido.');
    const was = task.state.mode;
    task.state = T.setMode(task.state, mode);
    return { prompt: mode === 'trust' && was !== 'trust' && phaseOf(task) === 'steps' ? TRUST_PROMPT : null };
  });

  const openAnyway = (sessionId) => act(sessionId, 'openAnyway', (task) => {
    task.state = T.openAnyway(task.state);
    return null;
  });

  // "ok, segue": what is done was seen, the next step goes.
  const okNext = (sessionId) => act(sessionId, 'okNext', (task) => {
    const phase = phaseOf(task);
    if (phase !== 'steps' && phase !== 'pr') return failed('Aprove o contrato e os testes antes.');
    for (const step of task.plan.steps) if (step.done) task.state = T.reviewStep(task.state, step.text);
    const next = pendingStep(task);
    return { prompt: next ? (next.dev ? devStepPrompt(next.text) : NEXT_STEP_PROMPT) : null };
  });

  const comment = (sessionId, text) => act(sessionId, 'comment', () => {
    const clean = String(text ?? '').trim().slice(0, MAX_COMMENT);
    return clean ? { prompt: clean } : failed('Escreva o comentário.');
  });

  const stepAt = (task, n) => (Number.isInteger(n) && n > 0 ? task.plan?.steps?.[n - 1] ?? null : null);

  const undoStep = (sessionId, n) => act(sessionId, `undoStep:${n}`, (task) => {
    const step = stepAt(task, n);
    if (!step?.done) return failed('Esse passo não está feito.');
    return { prompt: undoStepPrompt(n, step.text) };
  });

  const devDone = (sessionId) => act(sessionId, 'devDone', (task) => {
    if (phaseOf(task) !== 'steps' || !pendingStep(task)?.dev) return failed('O passo atual não é [dev].');
    return { prompt: DEV_DONE_PROMPT };
  });

  // Back to the files of checkpoint N-1, with every chat of the task stopped. Nothing is deleted.
  const restoreBefore = (sessionId, n) => act(sessionId, 'restoreBefore', async (task) => {
    if (!Number.isInteger(n) || n < 1) return failed('Passo inválido.');
    if ([sessionId, ...task.state.sessions].some((id) => isWorking(id))) return failed('O agente está trabalhando: espere ele parar antes de voltar.');
    const ref = task.state.checkpoints[n - 1];
    if (!ref) return failed(`Não há ponto salvo antes do passo ${n}.`);
    let result;
    try {
      result = await checkpoints.restore(task.worktree, ref);
    } catch (error) {
      return failed(String(error?.message ?? error));
    }
    // The later checkpoints are of files that are gone; their steps take new ones once redone.
    const kept = Object.fromEntries(Object.entries(task.state.checkpoints).filter(([step]) => Number(step) < n));
    const waiting = (task.plan?.steps ?? []).map((step, index) => (index + 1 >= n && step.done ? index + 1 : null)).filter(Boolean);
    task.state = { ...task.state, checkpoints: kept, waitUntick: [...new Set([...task.state.waitUntick, ...waiting])] };
    return { restored: result.restored, left: result.left, prompt: restoredPrompt(n, result.left) };
  });

  // A tombstone stays: the chat writing its plan again must not re-gate it.
  async function endTask(sessionId) {
    const task = taskOf(sessionId);
    if (!task) return failed(NO_TASK);
    await serial(task, async () => {
      for (const id of task.state.sessions) if (bySession.get(id) === task.key) bySession.delete(id);
      bySession.delete(sessionId);
      task.generation++;
      task.plan = null;
      task.state = freshState(task, { ended: true });
      task.saved = true;
      await persist(task);
      await dropRefs(task);
    });
    await settle();
    return { ok: true };
  }

  const quick = (sessionId) => act(sessionId, 'quick', async (task) => {
    task.state = { ...task.state, quick: true };
    await takeBaseline(task);
    return { prompt: APPROVE_PROMPT };
  });

  const APPROVE_REFUSED = 'esta tarefa tem contrato: aprove o contrato no card';
  // Why the old "Aprovar plano" does not apply, or null: it is the quick tasks' ok only.
  function approveRefusal(sessionId) {
    const task = taskOf(sessionId);
    return task && phaseOf(task) !== 'quick' ? APPROVE_REFUSED : null;
  }

  // The old plan's "Aprovar plano" (a quick task): its baseline, once.
  const approvePlan = (sessionId) => act(sessionId, 'approvePlan', async (task) => {
    if (phaseOf(task) !== 'quick') return failed(APPROVE_REFUSED);
    await takeBaseline(task);
    return null;
  });

  // --- what the card shows ---------------------------------------------------
  async function todosOf(task) {
    if (!git) return [];
    try {
      return parseTodoGrep(await git(['grep', '-n', '-I', '--untracked', '-F', '-e', 'TODO(dev):'], { cwd: task.worktree }));
    } catch {
      return []; // git grep exits 1 with no match
    }
  }

  function stepsOf(task) {
    const { state: s, plan } = task;
    return (plan?.steps ?? []).map((step, index) => ({
      n: index + 1, text: step.text, done: step.done, why: step.why, dev: step.dev,
      reviewed: s.reviewed.includes(T.stepKey(step.text)), checkpoint: Boolean(s.checkpoints[index + 1]), restorePoint: Boolean(s.checkpoints[index]),
    }));
  }

  // What still keeps the PR closed, in the card's words.
  function blockersOf(task, phase = phaseOf(task), steps = stepsOf(task)) {
    const blockers = [];
    if (phase === 'contract') blockers.push('aprove o contrato');
    if (phase === 'tests') blockers.push('aprove os testes');
    if (phase === 'steps' || phase === 'pr') {
      const pending = steps.filter((step) => !step.done).length;
      const unreviewed = steps.filter((step) => step.done && !step.reviewed).length;
      if (pending) blockers.push(`${plural(pending, 'passo')} por fazer`);
      if (unreviewed && !task.state.openAnyway) blockers.push(`${plural(unreviewed, 'passo')} sem revisão`);
    }
    if (task.state.changedLocked.length) blockers.push('o teste do contrato mudou');
    return blockers;
  }

  // Why the PR may not be opened yet, or null: a quick task and a chat with no task open it as before.
  function prRefusal(sessionId) {
    const task = taskOf(sessionId);
    if (!task || phaseOf(task) === 'quick') return null;
    const blockers = blockersOf(task);
    if (!blockers.length) return null;
    return blockers.map((text) => (text.endsWith('sem revisão') ? `${text} — use abrir assim mesmo` : text)).join('; ');
  }

  async function state(sessionId) {
    const task = taskOf(sessionId);
    if (!task) return null;
    const { state: s, plan } = task;
    const phase = phaseOf(task);
    const steps = stepsOf(task);
    const current = steps.find((step) => !step.done) ?? null;
    const locked = Object.keys(s.tests?.hashes ?? {});
    const files = plan?.contractFiles ?? [];
    const blockers = blockersOf(task, phase, steps);
    return {
      issue: task.issue,
      worktree: task.worktree,
      phase,
      mode: s.mode,
      quick: s.quick,
      title: plan?.title ?? '',
      error: plan?.error ?? null,
      contract: plan?.contract ?? null,
      contractApproved: Boolean(s.contract) && phase !== 'contract',
      tests: {
        files,
        command: plan?.testCommand ?? null,
        approvedCommand: s.tests?.command ?? null,
        locked,
        changedLocked: s.changedLocked,
        changedDiffs: Object.fromEntries(await Promise.all(s.changedLocked.map(async (file) => [file, await lockDiff(task, file)]))),
        contractFilesChanged: Boolean(s.tests) && JSON.stringify([...files].sort()) !== JSON.stringify([...locked].sort()),
      },
      run: { running: task.running > 0, last: s.lastRun },
      steps,
      current: current?.n ?? null,
      devTodos: current?.dev && phase === 'steps' ? await todosOf(task) : [],
      working: s.sessions.some((id) => isWorking(id)),
      openAnyway: s.openAnyway,
      pr: { ready: blockers.length === 0, blockers },
    };
  }

  const ACTIONS = { approveContract, approveTests, unlockTests, reviewStep, setMode, okNext, comment, undoStep, restoreBefore, devDone, endTask, quick, openAnyway };

  return {
    start,
    bind,
    onPlan,
    onStop,
    state,
    hasActive,
    prRefusal,
    approveRefusal,
    approvePlan,
    reopen,
    ...ACTIONS,
    // The IPC's door: only the card's actions, by name.
    run: (sessionId, action, arg) => (Object.hasOwn(ACTIONS, action) ? ACTIONS[action](sessionId, arg) : Promise.resolve(failed('Ação desconhecida.'))),
    sessionsOf: () => [...bySession.keys()],
    // The checkpoint refs of a task (step → ref), for the review's per-step diff.
    checkpointsOf: (worktree, issue) => tasks.get(T.taskKey(worktree, issue))?.state.checkpoints ?? {},
  };
}
