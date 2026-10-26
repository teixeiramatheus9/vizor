import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { MAX_DIFF_BYTES } from '../edit-hunks.js';
import { touchedFunctions } from '../graph/impact.js';
import { baseCandidates, markCommitted, parseNumstatZ, parseUnifiedDiff, untrackedAsFiles } from './git-diff.js';
import { contractChanges, isSchemaPath, packageChanges } from './contract.js';
import { parseProjectConfig } from './project-config.js';
import { egoSlice, untestedModules } from './slice.js';
import { buildVerdict } from './verdict.js';
import { readingOrder } from './reading-order.js';
import { testCommand, tscPlan } from './verify.js';

// The review service of main: composes the pure review modules over injected
// IO. The list is cheap (numstat + name-status), patches are read only for the
// file on screen, and nothing recomputes on its own: invalidate() only marks a
// worktree dirty and emits 'changed'; the screen then asks again.
const DEBOUNCE_MS = 300;
const MAX_VIEW_LINES = 3000;
const BASE_TEXT_CACHE = 500;
const CHUNK = 8;
const SOURCE = /\.(m|c)?[jt]sx?$/;
const STATUS = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };

const BASE_ERROR = 'Não achei a branch base (tentei main e master). Defina "base" em .vizor/projeto.json.';
const ERR_COMMITTED = 'já está num commit; comente pra o agente reverter';
const ERR_BUSY = 'espere o agente parar';
const ERR_NEW_FILE = 'arquivo novo: peça pro agente apagar';
const ERR_CHANGED = 'o arquivo mudou; atualize';

// `git diff --name-status -z -M`: "M\0path\0", renames "R100\0old\0new\0".
function parseNameStatusZ(text) {
  const parts = text.split('\0');
  const out = new Map();
  for (let i = 0; i < parts.length;) {
    const code = parts[i];
    if (!code) { i++; continue; }
    const kind = code[0];
    if (kind === 'R' || kind === 'C') { out.set(parts[i + 2], STATUS[kind]); i += 3; }
    else { out.set(parts[i + 1], STATUS[kind] ?? 'modified'); i += 2; }
  }
  return out;
}

export function createReviewService({
  git, readFile, stat, graphFor, verifier, storeFor, sessionsOf,
  setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout,
  cacheDir = path.join(os.homedir(), '.cache', 'vizor', 'tsc'),
}) {
  const service = new EventEmitter();
  const states = new Map();
  let requestSource = () => null;
  let paused = false;
  const parked = []; // verifies that arrived while paused

  const stateOf = (wt) => {
    if (!states.has(wt)) {
      states.set(wt, { base: null, config: null, files: new Map(), epoch: 0, dirty: false, timer: null, tsc: null, tests: null, store: null, approved: null, untracked: null, baseTexts: new Map(), baseSha: null, open: null });
    }
    return states.get(wt);
  };
  const run = (wt, args, input) => git(['-c', 'core.quotePath=false', ...args], wt, input);
  const suffix = (sha, rel, stamp) => `${sha}\0${rel}\0${stamp}`;
  const abs = (wt, rel) => path.join(wt, rel);
  const readText = (wt, rel) => readFile(abs(wt, rel), 'utf8').catch(() => null);
  const statOf = (wt, rel) => stat(abs(wt, rel)).catch(() => null);
  const keyOf = (st) => (st ? `${st.mtimeMs}:${st.size}` : 'gone');

  async function configOf(wt) {
    const s = stateOf(wt);
    s.config ??= parseProjectConfig((await readText(wt, '.vizor/projeto.json')) ?? '');
    return s.config;
  }

  async function baseOf(wt) {
    const s = stateOf(wt);
    s.base ??= (async () => {
      const config = await configOf(wt);
      const upstream = (await run(wt, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
      for (const candidate of baseCandidates({ upstream, config })) {
        try {
          const sha = (await run(wt, ['merge-base', 'HEAD', candidate])).trim();
          if (sha) return { sha };
        } catch { /* next candidate */ }
      }
      return { error: BASE_ERROR };
    })();
    return s.base;
  }

  // Merge-base texts of the files that need them, from ONE `git cat-file
  // --batch`: "<sha>:<path>" in, "<oid> blob <size>\n<bytes>\n" or
  // "<spec> missing\n" out. The cache lives per worktree and per base sha.
  async function prefetchBase(wt, sha, files) {
    const s = stateOf(wt);
    if (s.baseSha !== sha) { s.baseTexts.clear(); s.baseSha = sha; }
    const want = files
      .filter((f) => !f.untracked && !f.binary && f.status !== 'deleted' && (SOURCE.test(f.path) || path.posix.basename(f.path) === 'package.json')
        && !s.baseTexts.has(f.path) && !f.path.includes('\n'))
      .map((f) => f.path);
    if (!want.length) return;
    const answer = await run(wt, ['cat-file', '--batch'], `${want.map((p) => `${sha}:${p}`).join('\n')}\n`).catch(() => '');
    const out = Buffer.from(answer, 'utf8');
    let pos = 0;
    for (const p of want) {
      const nl = out.indexOf(10, pos);
      if (nl < 0) break;
      const size = /^\S+ blob (\d+)$/.exec(out.toString('utf8', pos, nl))?.[1];
      pos = nl + 1;
      if (size === undefined) { s.baseTexts.set(p, null); continue; } // missing at the base
      if (pos + Number(size) > out.length) break; // out of sync: leave the rest uncached
      s.baseTexts.set(p, out.toString('utf8', pos, pos + Number(size)));
      pos += Number(size) + 1;
    }
  }

  async function chunked(items, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += CHUNK) out.push(...await Promise.all(items.slice(i, i + CHUNK).map(fn)));
    return out;
  }

  const countLines = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

  // The changed files with their cheap numbers, no patches.
  async function listChanged(wt, sha) {
    const [numstat, names, others] = await Promise.all([
      run(wt, ['diff', '--numstat', '-z', '-M', sha]),
      run(wt, ['diff', '--name-status', '-z', '-M', sha]),
      run(wt, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
    ]);
    const status = parseNameStatusZ(names);
    const files = parseNumstatZ(numstat).map((f) => ({
      path: f.path, status: status.get(f.path) ?? 'modified', added: f.added, removed: f.removed, binary: f.binary, contract: false, untracked: false,
    }));
    const tracked = new Set(files.map((f) => f.path));
    const untracked = others.split('\0').filter((p) => p && !tracked.has(p));
    const extra = await chunked(untracked, async (p) => {
      const text = await readText(wt, p);
      const binary = text !== null && text.slice(0, 8000).includes('\0');
      return { path: p, status: 'added', added: binary || text === null ? null : countLines(text), removed: binary || text === null ? null : 0, binary, contract: false, untracked: true };
    });
    stateOf(wt).untracked = new Set(untracked);
    return [...files, ...extra];
  }

  // Per-file analysis (contract changes + changed function ids), cached by
  // (base, path, mtime, size) like the patch.
  async function analyse(wt, sha, file, graph, stamp) {
    const s = stateOf(wt);
    const key = suffix(sha, file.path, stamp);
    let entry = s.files.get(`a\0${key}`);
    if (!entry) {
      entry = { changes: [], before: undefined, after: undefined };
      if (file.status !== 'deleted' && !file.binary) {
        const isPackage = path.posix.basename(file.path) === 'package.json';
        if (SOURCE.test(file.path) || isPackage) {
          const before = file.untracked ? null : (s.baseTexts.get(file.path) ?? null);
          const after = await readText(wt, file.path);
          entry.before = before;
          entry.after = after;
          if (isPackage) entry.changes = packageChanges(before ?? '{}', after ?? '{}');
          else entry.changes = contractChanges({ relPath: file.path, before, after });
        }
        if (isSchemaPath(file.path)) entry.changes = [...entry.changes, { kind: 'schema', name: file.path, before: null, after: null }];
      }
      s.files.set(`a\0${key}`, entry);
    }
    let functions = [];
    if (graph && entry.after !== undefined && SOURCE.test(file.path)) functions = touchedFunctions(graph, file.path, entry.before ?? null, entry.after ?? '');
    return { changes: entry.changes, functions };
  }

  const readyGraph = (wt) => {
    try {
      const g = graphFor(wt)?.graph();
      return g && !g.unavailable ? g : null;
    } catch {
      return null;
    }
  };

  async function loadApproved(wt) {
    const s = stateOf(wt);
    s.store ??= storeFor(wt);
    s.approved ??= s.store.load().then((r) => new Set(r.approved));
    return s.approved;
  }

  const stampsOf = async (wt, files) => {
    const stamps = new Map();
    await chunked(files, async (f) => { stamps.set(f.path, keyOf(await statOf(wt, f.path))); });
    return stamps;
  };

  const approxBytes = (file) => (file?.hunks ?? []).reduce((n, h) => n + h.header.length + h.lines.reduce((m, l) => m + l.text.length + 2, 0), 0);

  // HEAD→worktree hunk ids, one process for the whole worktree, per epoch.
  async function openIds(wt) {
    const s = stateOf(wt);
    if (s.open?.epoch !== s.epoch) {
      const head = parseUnifiedDiff(await run(wt, ['diff', '-U3', 'HEAD']));
      s.open = { epoch: s.epoch, ids: new Set(head.flatMap((f) => f.hunks.map((h) => h.id))) };
    }
    return s.open.ids;
  }

  // Every changed file's parsed patch from ONE `git diff -U3 <base>` (plus
  // untracked files read as all-added), only when some entry is cold.
  async function ensurePatches(wt, sha, files, stamps) {
    const s = stateOf(wt);
    const cold = files.filter((f) => !s.files.has(`p\0${suffix(sha, f.path, stamps.get(f.path))}`));
    if (cold.length) {
      const parsed = new Map(!cold.some((f) => !f.untracked) ? [] : parseUnifiedDiff(await run(wt, ['diff', '-U3', sha])).map((f) => [f.path, f]));
      for (const f of cold) {
        const text = f.untracked ? await readText(wt, f.path) : null;
        const file = f.untracked ? untrackedAsFiles([f.path], () => text)[0] : parsed.get(f.path) ?? null;
        s.files.set(`p\0${suffix(sha, f.path, stamps.get(f.path))}`, { file, untracked: f.untracked, bytes: approxBytes(file), epoch: -1, committedIds: null });
      }
    }
    await openIds(wt);
  }

  // Drop what no longer belongs: other bases, files that left the list, and
  // older mtime/size versions of a file still in it.
  function evict(wt, sha, files, stamps) {
    const s = stateOf(wt);
    const valid = new Set(files.map((f) => suffix(sha, f.path, stamps.get(f.path))));
    for (const key of [...s.files.keys()]) if (!valid.has(key.slice(2))) s.files.delete(key);
    const paths = new Set(files.map((f) => f.path));
    for (const rel of [...s.baseTexts.keys()]) if (!paths.has(rel)) s.baseTexts.delete(rel);
  }

  async function summary(wt) {
    const base = await baseOf(wt);
    if (base.error) return { base: null, baseError: base.error, files: [], order: [], verdict: buildVerdict({}), contract: [], request: requestSource(wt) ?? null };
    const files = await listChanged(wt, base.sha);
    const graph = readyGraph(wt);
    const stamps = await stampsOf(wt, files);
    await prefetchBase(wt, base.sha, files);
    const analysed = await chunked(files, (f) => analyse(wt, base.sha, f, graph, stamps.get(f.path)));
    await ensurePatches(wt, base.sha, files, stamps);
    evict(wt, base.sha, files, stamps);
    const contract = [];
    analysed.forEach((a, i) => {
      if (!a.changes.length) return;
      files[i].contract = true;
      contract.push({ path: files[i].path, changes: a.changes });
    });
    let untestedChanged = 0;
    if (graph) {
      const untested = untestedModules(graph);
      analysed.forEach((a, i) => { if (untested.has(files[i].path)) untestedChanged += a.functions.length; });
    }
    const approved = await loadApproved(wt);
    const s = stateOf(wt);
    let approvedCount = 0;
    let totalHunks = 0;
    const live = [];
    for (const f of files) {
      const ids = s.files.get(`p\0${suffix(base.sha, f.path, stamps.get(f.path))}`)?.file?.hunks.map((h) => h.id) ?? [];
      totalHunks += ids.length;
      approvedCount += ids.filter((id) => approved.has(id)).length;
      live.push(...ids);
    }
    s.store.prune?.(live);
    const order = readingOrder(files, { graph, contractPaths: contract.map((c) => c.path) }).map((f) => f.path);
    const verdict = buildVerdict({
      files, tsc: s.tsc, tests: s.tests, untestedChanged,
      contract: contract.reduce((n, c) => n + c.changes.length, 0), approved: approvedCount, totalHunks,
    });
    return { base: base.sha, baseError: null, files, order, verdict, contract, request: requestSource(wt) ?? null };
  }

  async function parsedPatch(wt, sha, rel, st) {
    const s = stateOf(wt);
    const key = `p\0${sha}\0${rel}\0${keyOf(st)}`;
    let entry = s.files.get(key);
    if (!entry) {
      const patch = await run(wt, ['diff', '-U3', sha, '--', rel]);
      let file = parseUnifiedDiff(patch)[0] ?? null;
      let untracked = false;
      let bytes = Buffer.byteLength(patch);
      if (!file) {
        const others = await run(wt, ['ls-files', '--others', '--exclude-standard', '-z', '--', rel]).catch(() => '');
        if (others.split('\0').includes(rel)) {
          const text = await readText(wt, rel);
          bytes = Buffer.byteLength(text ?? '');
          file = untrackedAsFiles([rel], () => text)[0];
          untracked = true;
        }
      }
      entry = { file, untracked, bytes, epoch: -1, committedIds: null };
      s.files.set(key, entry);
    }
    return entry;
  }

  async function file(wt, rel, { force = false } = {}) {
    const base = await baseOf(wt);
    if (base.error) return { path: rel, status: 'modified', hunks: [], error: base.error, tscErrors: [] };
    const s = stateOf(wt);
    const st = await statOf(wt, rel);
    const entry = s.files.get(`p\0${suffix(base.sha, rel, keyOf(st))}`) ?? await parsedPatch(wt, base.sha, rel, st);
    const parsed = entry.file ?? { path: rel, status: st ? 'modified' : 'deleted', binary: false, hunks: [] };
    const tscErrors = (s.tsc?.errors ?? []).filter((e) => e.file === rel).map(({ line, col, message }) => ({ line, col, message }));
    if (parsed.binary) return { path: rel, status: parsed.status, binary: true, hunks: [], tscErrors };
    const lines = parsed.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (entry.bytes > MAX_DIFF_BYTES || (lines > MAX_VIEW_LINES && !force)) return { path: rel, status: parsed.status, tooBig: true, lines, hunks: [], tscErrors };

    // Which hunks already live in a commit depends on HEAD, so it is dropped
    // on invalidate even though the patch against the base stays cached.
    if (entry.epoch !== s.epoch) {
      entry.committedIds = new Set();
      if (!entry.untracked && parsed.hunks.length) {
        const open = s.open?.epoch === s.epoch
          ? s.open.ids
          : new Set(parseUnifiedDiff(await run(wt, ['diff', '-U3', 'HEAD', '--', rel])).flatMap((f) => f.hunks.map((h) => h.id)));
        for (const h of parsed.hunks) if (!open.has(h.id)) entry.committedIds.add(h.id);
      }
      entry.epoch = s.epoch;
    }
    const approved = await loadApproved(wt);
    const hunks = parsed.hunks.map((h) => ({ ...h, committed: entry.committedIds.has(h.id), approved: approved.has(h.id) }));
    return { path: rel, status: parsed.status, hunks, tscErrors, ...(entry.untracked ? { untracked: true } : {}) };
  }

  async function approve(wt, id, on) {
    const approved = await loadApproved(wt);
    if (on) approved.add(id); else approved.delete(id);
    stateOf(wt).store.approve(id, on);
  }

  async function reject(wt, rel, id) {
    const view = await file(wt, rel, { force: true });
    const hunk = view.hunks.find((h) => h.id === id);
    if (!hunk) return { ok: false, error: ERR_CHANGED };
    if (view.untracked) return { ok: false, error: ERR_NEW_FILE };
    if (hunk.committed) return { ok: false, error: ERR_COMMITTED };
    if (sessionsOf(wt).some((s) => s.status !== 'done' && s.status !== 'waiting')) return { ok: false, error: ERR_BUSY };
    // The marker after a line is what keeps `git apply` from demanding a final newline there.
    const body = hunk.lines.map((l) => `${l.kind}${l.text}\n${l.noNewline ? '\\ No newline at end of file\n' : ''}`).join('');
    const patch = `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n${hunk.header}\n${body}`;
    try {
      await run(wt, ['apply', '-R', '--check'], patch);
      await run(wt, ['apply', '-R'], patch);
    } catch {
      return { ok: false, error: ERR_CHANGED };
    }
    invalidate(wt);
    return { ok: true };
  }

  async function slice(wt, { expanded = [], showHidden = false } = {}) {
    const indexer = graphFor(wt);
    const graph = indexer?.graph();
    if (graph?.unavailable) return { status: 'unavailable', reason: graph.unavailable };
    if (!graph) {
      if (!indexer) return { status: 'unavailable', reason: 'sem grafo neste projeto' };
      // The indexer reports no progress, so done/total stay 0/0.
      Promise.resolve(indexer.refresh?.()).catch(() => {});
      return { status: 'building', done: 0, total: 0 };
    }
    const base = await baseOf(wt);
    if (base.error) return { status: 'unavailable', reason: base.error };
    const files = await listChanged(wt, base.sha);
    const stamps = await stampsOf(wt, files);
    await prefetchBase(wt, base.sha, files);
    const analysed = await chunked(files, (f) => analyse(wt, base.sha, f, graph, stamps.get(f.path)));
    return { status: 'ready', slice: egoSlice(graph, analysed.flatMap((a) => a.functions), { expanded, showHidden }) };
  }

  async function planFor(wt, kind) {
    const config = await configOf(wt);
    if (kind === 'tsc') {
      const [tsconfigText, tscBin] = await Promise.all([readText(wt, 'tsconfig.json'), statOf(wt, 'node_modules/.bin/tsc')]);
      return tscPlan({ root: wt, tsconfigText, hasLocalTsc: Boolean(tscBin), config, cacheDir });
    }
    const command = testCommand({ packageText: await readText(wt, 'package.json'), config });
    return command ? { command } : { skip: 'sem script de testes no projeto' };
  }

  function announce(wt) {
    stateOf(wt).dirty = true;
    if (!paused) flushDirty(wt);
  }
  function flushDirty(wt) {
    const s = stateOf(wt);
    if (!s.dirty) return;
    s.dirty = false;
    service.emit('changed', wt);
  }

  async function execute(wt, kind, plan) {
    const s = stateOf(wt);
    if (plan.skip) { s[kind] = { kind, status: 'skipped', reason: plan.skip, ms: 0 }; announce(wt); return s[kind]; }
    s[kind] = { kind, status: 'running' };
    announce(wt);
    const result = await verifier.run(wt, kind, plan);
    if (result.status === 'cancelled') return result; // a newer run owns the state now
    s[kind] = result;
    announce(wt);
    return result;
  }

  async function verify(wt, kind) {
    const plan = await planFor(wt, kind);
    if (paused) await new Promise((resolve) => parked.push(resolve));
    return execute(wt, kind, plan);
  }

  function invalidate(wt) {
    const s = stateOf(wt);
    s.base = null;
    s.config = null;
    s.epoch++;
    if (s.timer != null) clearTimer(s.timer);
    s.timer = setTimer(() => { s.timer = null; announce(wt); }, DEBOUNCE_MS);
  }

  Object.assign(service, {
    setRequestSource(fn) { requestSource = typeof fn === 'function' ? fn : () => null; },
    summary, file, approve, reject, slice, verify, invalidate,
    pause() { paused = true; },
    resume() {
      paused = false;
      for (const wt of states.keys()) flushDirty(wt);
      for (const release of parked.splice(0)) release();
    },
    async onAgentStop(wt) {
      const plan = await planFor(wt, 'tsc');
      if (plan.skip) { stateOf(wt).tsc = { kind: 'tsc', status: 'skipped', reason: plan.skip, ms: 0 }; return; }
      return verify(wt, 'tsc');
    },
  });
  return service;
}
