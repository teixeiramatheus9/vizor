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
const SETTLE_MS = 1000;
const EXPORT_LINE = /^\s*(export\b|module\.exports\b)/;
const SOURCE = /\.(m|c)?[jt]sx?$/;
const STATUS = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };

const BASE_ERROR = 'Não achei a branch base (tentei main e master). Defina "base" em .vizor/projeto.json.';
const ERR_COMMITTED = 'já está num commit; comente pra o agente reverter';
const ERR_BUSY = 'espere o agente parar';
const ERR_NEW_FILE = 'arquivo novo: peça pro agente apagar';
const ERR_CHANGED = 'o arquivo mudou; atualize';

// `git diff --raw --numstat -z -M`: the raw records first (":100644 100644 a b M\0path\0",
// renames "…R100\0old\0new\0"), then the numstat ones. Returns the status of each path
// and the numstat text left over.
function splitRawNumstat(text) {
  const parts = text.split('\0');
  const status = new Map();
  let i = 0;
  while (i < parts.length && parts[i].startsWith(':')) {
    const kind = parts[i].slice(parts[i].lastIndexOf(' ') + 1)[0];
    if (kind === 'R' || kind === 'C') { status.set(parts[i + 2], STATUS[kind]); i += 3; }
    else { status.set(parts[i + 1], STATUS[kind] ?? 'modified'); i += 2; }
  }
  return { status, numstat: parts.slice(i).join('\0') };
}

export function createReviewService({
  git, readFile, stat, graphFor, graphBuilt = (wt) => graphFor(wt)?.graph(), verifier, storeFor, sessionsOf,
  setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout,
  cacheDir = path.join(os.homedir(), '.cache', 'vizor', 'tsc'),
  startPaused = false, now = Date.now, log = () => {},
}) {
  const service = new EventEmitter();
  const states = new Map();
  let requestSource = () => null;
  // main starts it paused: nothing runs before the workspace window first shows.
  let paused = startPaused;
  const parked = new Map(); // `${wt}\0${kind}` → the release of the one verify waiting out a pause
  const asked = new Set(); // worktrees the screen has read: only they get a tsc on agent stop

  const stateOf = (wt) => {
    if (!states.has(wt)) {
      states.set(wt, { base: null, config: null, files: new Map(), epoch: 0, dirty: false, timer: null, tsc: null, tests: null, store: null, approved: null, untracked: null, untrackedSeen: null, baseTexts: new Map(), baseSha: null, open: null, openRun: null, refreshing: null, order: null, analysing: null, landedAt: null });
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
      const probe = (candidate) => run(wt, ['merge-base', 'HEAD', candidate]).then((out) => out.trim(), () => '');
      // The fixed candidates do not depend on the upstream: they are probed while
      // it is asked for, so a repo without one resolves in a single round of git.
      const probes = new Map(baseCandidates({ config }).map((candidate) => [candidate, probe(candidate)]));
      const upstream = (await run(wt, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim();
      // The branch name only matters to tell an upstream that is this branch pushed.
      const branch = upstream ? (await run(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() : '';
      for (const candidate of baseCandidates({ upstream, config, branch })) {
        const sha = await (probes.get(candidate) ?? probe(candidate));
        if (sha) return { sha };
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
        && !s.baseTexts.has(f.path) && !f.path.includes('\n') && !f.oldPath?.includes('\n'))
      ;
    if (!want.length) return;
    const answer = await run(wt, ['cat-file', '--batch'], `${want.map((f) => `${sha}:${f.oldPath ?? f.path}`).join('\n')}\n`).catch(() => '');
    const out = Buffer.from(answer, 'utf8');
    let pos = 0;
    for (const { path: p } of want) {
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
    const [changed, others] = await Promise.all([
      run(wt, ['diff', '--raw', '--numstat', '-z', '-M', sha]),
      run(wt, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
    ]);
    const { status, numstat } = splitRawNumstat(changed);
    const files = parseNumstatZ(numstat).map((f) => ({
      path: f.path, oldPath: f.oldPath, status: status.get(f.path) ?? 'modified', added: f.added, removed: f.removed, binary: f.binary, contract: false, untracked: false,
    }));
    const tracked = new Set(files.map((f) => f.path));
    const untracked = others.split('\0').filter((p) => p && !tracked.has(p));
    const s = stateOf(wt);
    const seen = new Map();
    const extra = await chunked(untracked, async (p) => {
      const info = await untrackedInfo(wt, p, s.untrackedSeen);
      seen.set(p, info);
      const counted = !info.binary && info.added !== null;
      return { path: p, status: 'added', added: counted ? info.added : null, removed: counted ? 0 : null, binary: info.binary, contract: false, untracked: true };
    });
    s.untracked = new Set(untracked);
    s.untrackedSeen = seen; // only the files still untracked stay cached
    return [...files, ...extra];
  }

  // An untracked file as an all-added patch, cached by (path, mtime, size) so
  // a summary or slice does not read it again. Over the diff limit it is never
  // read: it shows as too big.
  async function untrackedInfo(wt, rel, cache) {
    const st = await statOf(wt, rel);
    const stamp = keyOf(st);
    const known = cache?.get(rel);
    if (known?.stamp === stamp) return known;
    if (st && st.size > MAX_DIFF_BYTES) {
      return { stamp, binary: false, added: null, bytes: st.size, file: { path: rel, oldPath: null, status: 'added', binary: false, hunks: [] } };
    }
    const text = await readText(wt, rel);
    const file = untrackedAsFiles([rel], () => text)[0];
    return { stamp, binary: file.binary, added: file.binary || text === null ? null : countLines(text), bytes: Buffer.byteLength(text ?? ''), file };
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
    return { changes: entry.changes, functions: functionsOf(entry, file, graph) };
  }

  // The diff of the two texts against the graph is the dear part and repeats
  // on every summary and slice: keep it for as long as this graph object lives.
  // Only this part depends on the graph; the contract changes never do.
  function functionsOf(entry, file, graph) {
    if (entry.graph !== graph) {
      entry.graph = graph;
      try {
        entry.functions = graph && entry.after !== undefined && SOURCE.test(file.path) ? touchedFunctions(graph, file.path, entry.before ?? null, entry.after ?? '') : [];
      } catch (error) {
        log(`review changed functions of ${file.path} failed: ${error?.message ?? error}`); // the contract part stays valid
        entry.functions = [];
      }
    }
    return entry.functions;
  }

  // graphFor starts the build when there is none; graphBuilt only looks.
  const readyGraph = (wt, ask = (root) => graphFor(root)?.graph()) => {
    try {
      const g = ask(wt);
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
  // Callers asking while the run is in flight share it.
  function openIds(wt) {
    const s = stateOf(wt);
    if (s.open?.epoch === s.epoch) return Promise.resolve(s.open.ids);
    if (s.openRun?.epoch !== s.epoch) {
      const epoch = s.epoch;
      const promise = run(wt, ['diff', '-U3', 'HEAD'])
        .then((text) => {
          const ids = new Set(parseUnifiedDiff(text).flatMap((f) => f.hunks.map((h) => h.id)));
          if (s.epoch === epoch) s.open = { epoch, ids };
          return ids;
        })
        .finally(() => { if (s.openRun?.promise === promise) s.openRun = null; });
      s.openRun = { epoch, promise };
    }
    return s.openRun.promise;
  }

  // Every changed file's parsed patch from ONE `git diff -U3 <base>` (plus
  // untracked files read as all-added), only when some entry is cold.
  async function ensurePatches(wt, sha, files, stamps) {
    const s = stateOf(wt);
    const cold = files.filter((f) => s.files.get(`p\0${suffix(sha, f.path, stamps.get(f.path))}`)?.lone !== false);
    // The HEAD hunk ids are a separate git run: started together with the base
    // diff, not after it (a cold list would otherwise wait for two in a row).
    const full = cold.some((f) => !f.untracked) ? run(wt, ['diff', '-U3', sha]) : null;
    const heads = openIds(wt);
    heads.catch(() => {}); // awaited below; a base-diff failure must not leave it unhandled
    if (cold.length) {
      const parsed = new Map(full ? parseUnifiedDiff(await full).map((f) => [f.path, f]) : []);
      for (const f of cold) {
        const info = f.untracked ? await untrackedInfo(wt, f.path, s.untrackedSeen) : null;
        const file = info ? info.file : parsed.get(f.path) ?? null;
        s.files.set(`p\0${suffix(sha, f.path, stamps.get(f.path))}`, { file, untracked: f.untracked, bytes: info ? info.bytes : approxBytes(file), epoch: -1, committedIds: null, lone: false });
      }
    }
    await heads;
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

  const emptySummary = (wt, baseError) => ({ base: null, baseError, files: [], order: [], verdict: buildVerdict({}), contract: [], request: requestSource(wt) ?? null });

  async function summary(wt) {
    asked.add(wt);
    try {
      return await summarise(wt);
    } catch (error) {
      // Unborn HEAD, not a git repo...: show it on screen, never throw to the IPC.
      log(`review summary of ${wt} failed: ${error?.stack ?? error}`);
      const why = String(error?.message ?? error).split('\n')[0].slice(0, 120);
      return emptySummary(wt, `não deu pra ler as mudanças: ${why}`);
    }
  }

  // A cheap guess at "this file changes a contract", from the patch already in
  // hand (no parsing): package.json, a schema path, or an added/removed export line.
  function likelyContract(wt, sha, file, stamp) {
    if (path.posix.basename(file.path) === 'package.json' || isSchemaPath(file.path)) return true;
    const patch = stateOf(wt).files.get(`p\0${suffix(sha, file.path, stamp)}`)?.file;
    return Boolean(patch?.hunks.some((h) => h.lines.some((l) => (l.kind === '+' || l.kind === '-') && EXPORT_LINE.test(l.text))));
  }

  // The analysis of a file only when it is already worked out: the summary never
  // waits for it. A file whose analysis failed is answered as "failed" (once per
  // file version) instead of pending, so the verdict never says "analisando…" forever.
  function cachedAnalysis(wt, sha, file, graph, stamp) {
    const s = stateOf(wt);
    const key = suffix(sha, file.path, stamp);
    const entry = s.files.get(`a\0${key}`);
    if (entry) return { changes: entry.changes, functions: functionsOf(entry, file, graph) };
    const failure = s.files.get(`f\0${key}`);
    return failure ? { changes: [], functions: [], failed: failure.reason } : null;
  }

  // The contract analysis, started after the answer went out and announced when
  // it lands. One run per worktree at a time; nothing starts while paused (the
  // next summary, on show, starts it).
  function analyseLater(wt, sha, files, graph, stamps) {
    const s = stateOf(wt);
    if (paused || s.analysing) return;
    s.analysing = (async () => {
      try {
        await prefetchBase(wt, sha, files);
        await chunked(files, async (f) => {
          const stamp = stamps.get(f.path);
          try {
            await analyse(wt, sha, f, graph, stamp);
          } catch (error) {
            log(`review contract analysis of ${wt}/${f.path} failed: ${error?.stack ?? error}`);
            s.files.set(`f\0${suffix(sha, f.path, stamp)}`, { reason: String(error?.message ?? error).split('\n')[0].slice(0, 80) });
          }
        });
      } catch (error) {
        log(`review contract analysis of ${wt} failed: ${error?.stack ?? error}`);
        const reason = String(error?.message ?? error).split('\n')[0].slice(0, 80);
        for (const f of files) if (!s.files.has(`a\0${suffix(sha, f.path, stamps.get(f.path))}`)) s.files.set(`f\0${suffix(sha, f.path, stamps.get(f.path))}`, { reason });
      }
      s.analysing = null; // before the announce: the summary it triggers may start the next run
      s.landedAt = now();
      if (states.get(wt) === s) announce(wt);
    })();
  }

  async function summarise(wt) {
    const base = await baseOf(wt);
    if (base.error) return emptySummary(wt, base.error);
    // The HEAD hunk ids need no file list: that git run goes out alongside it.
    openIds(wt).catch(() => {}); // ensurePatches shares it and reports a failure
    const files = await listChanged(wt, base.sha);
    // A cold graph starts building only after the answer is worked out: its parsing
    // and file reads would compete with the first list for the main thread.
    const graph = readyGraph(wt, graphBuilt);
    try {
      return await finishSummary(wt, base, files, graph);
    } finally {
      if (!graph) readyGraph(wt); // even when the work above threw: the Impacto tab still needs the build
    }
  }

  async function finishSummary(wt, base, files, graph) {
    const stamps = await stampsOf(wt, files);
    // The contract analysis (merge-base texts + babel on both sides) is the dear
    // part of a cold list and nothing on screen needs it to be readable: the
    // answer carries whatever is already cached and the rest is worked out
    // right after, announced as a 'changed' when it lands.
    await ensurePatches(wt, base.sha, files, stamps);
    evict(wt, base.sha, files, stamps);
    const analysed = files.map((f) => cachedAnalysis(wt, base.sha, f, graph, stamps.get(f.path)));
    const pending = analysed.some((a) => !a);
    const failures = analysed.filter((a) => a?.failed);
    if (pending) analyseLater(wt, base.sha, files, graph, stamps);
    const contract = [];
    analysed.forEach((a, i) => {
      if (!a?.changes.length) return;
      files[i].contract = true;
      contract.push({ path: files[i].path, changes: a.changes });
    });
    let untestedChanged = 0;
    if (graph) {
      const untested = untestedModules(graph);
      analysed.forEach((a, i) => { if (a && untested.has(files[i].path)) untestedChanged += a.functions.length; });
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
    // The order is worked out once per set of files: a graph or a contract
    // change landing later must not reshuffle what the dev is reading. The one
    // exception is the first analysis of a cold set: while it is pending the order
    // is provisional (no contract data, so no contract-first yet) and is redone
    // once when the analysis lands, but only within SETTLE_MS of the first answer;
    // later than that the dev may already be reading, so the provisional order is
    // frozen (badges and verdict still update). Freezing the cold order outright
    // would lose contract-first on every first open.
    // Files not analysed yet count as contract when they look like it.
    const contractPaths = [...new Set([...contract.map((c) => c.path), ...files.filter((f, i) => !analysed[i] && likelyContract(wt, base.sha, f, stamps.get(f.path))).map((f) => f.path)])];
    const set = files.map((f) => f.path).sort().join('\0');
    const order_ = () => readingOrder(files, { graph, contractPaths }).map((f) => f.path);
    if (s.order?.set !== set) {
      s.landedAt = null;
      s.order = { set, provisional: pending, at: now(), paths: order_() };
    } else if (s.order.provisional && !pending) {
      // Judged by when the analysis landed, not by when this summary was asked.
      if ((s.landedAt ?? now()) - s.order.at <= SETTLE_MS) s.order = { ...s.order, provisional: false, paths: order_() };
      else s.order.provisional = false;
    }
    const order = s.order.paths;
    const verdict = buildVerdict({
      files, tsc: s.tsc, tests: s.tests, untestedChanged,
      contract: contract.reduce((n, c) => n + c.changes.length, 0), contractPending: pending, contractFailed: failures.length ? failures[0].failed : null, approved: approvedCount, totalHunks,
    });
    return { base: base.sha, baseError: null, files, order, verdict, contract, request: requestSource(wt) ?? null };
  }

  // A file opened before any summary: its patch comes from the same full-diff
  // parse the summary uses, since a diff limited to one path cannot pair a
  // rename (it would show the file as added, with one all-added hunk).
  async function coldPatch(wt, sha, rel, st) {
    const s = stateOf(wt);
    const key = `p\0${suffix(sha, rel, keyOf(st))}`;
    const files = await listChanged(wt, sha);
    if (files.some((f) => f.path === rel)) {
      await ensurePatches(wt, sha, files, await stampsOf(wt, files));
      if (s.files.has(key)) return s.files.get(key);
    }
    return parsedPatch(wt, sha, rel, st);
  }

  // One path's own diff, for a file outside the list (or one that changed
  // between the stat and the list). Marked lone: the next summary replaces it.
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
          const info = await untrackedInfo(wt, rel, s.untrackedSeen);
          bytes = info.bytes;
          file = info.file;
          untracked = true;
        }
      }
      entry = { file, untracked, bytes, epoch: -1, committedIds: null, lone: true };
      s.files.set(key, entry);
    }
    return entry;
  }

  async function file(wt, rel, { force = false } = {}) {
    asked.add(wt);
    const base = await baseOf(wt);
    if (base.error) return { path: rel, status: 'modified', hunks: [], error: base.error, tscErrors: [] };
    const s = stateOf(wt);
    const st = await statOf(wt, rel);
    const entry = s.files.get(`p\0${suffix(base.sha, rel, keyOf(st))}`) ?? await coldPatch(wt, base.sha, rel, st);
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
    if (sessionsOf(wt).some((s) => s.status === 'working')) return { ok: false, error: ERR_BUSY };
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
    asked.add(wt);
    const indexer = graphFor(wt);
    const graph = indexer?.graph();
    if (graph?.unavailable) return { status: 'unavailable', reason: graph.unavailable };
    if (!graph) {
      if (!indexer) return { status: 'unavailable', reason: 'sem grafo neste projeto' };
      // The indexer reports no progress, so done/total stay 0/0.
      // One refresh in flight per worktree: the indexer queues another full
      // rebuild for every call made while it runs, so polling must not re-ask.
      const s = stateOf(wt);
      if (!s.refreshing) {
        s.refreshing = Promise.resolve(indexer.refresh?.()).catch(() => {}).finally(() => { s.refreshing = null; });
      }
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

  // With a debounce pending the notice rides it: whatever lands inside those
  // 300 ms goes out as one 'changed'.
  function announce(wt) {
    const s = stateOf(wt);
    s.dirty = true;
    if (!paused && s.timer == null) flushDirty(wt);
  }
  function schedule(wt) {
    const s = stateOf(wt);
    if (s.timer != null) clearTimer(s.timer);
    s.timer = setTimer(() => { s.timer = null; announce(wt); }, DEBOUNCE_MS);
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
    if (paused) {
      // Ten stops while hidden are one tsc on show: a newer ask replaces the parked one.
      const key = `${wt}\0${kind}`;
      const run = await new Promise((resolve) => { parked.get(key)?.(false); parked.set(key, resolve); });
      if (!run) return { kind, status: 'cancelled' };
    }
    return execute(wt, kind, plan);
  }

  function invalidate(wt) {
    const s = stateOf(wt);
    s.base = null;
    s.config = null;
    s.epoch++;
    schedule(wt);
  }

  Object.assign(service, {
    setRequestSource(fn) { requestSource = typeof fn === 'function' ? fn : () => null; },
    summary, file, approve, reject, slice, verify, invalidate,
    // A notice from outside (a graph batch, an issue body) that joins the debounce.
    notify(wt) { stateOf(wt).dirty = true; schedule(wt); },
    pause() { paused = true; },
    // Back on screen: what got dirty while hidden goes out through the debounce,
    // merged with the notices and the focus invalidate that follow the show.
    resume() {
      paused = false;
      for (const [wt, s] of states) if (s.dirty) schedule(wt);
      const released = [...parked.values()];
      parked.clear();
      for (const release of released) release(true);
    },
    async onAgentStop(wt) {
      if (!asked.has(wt)) return; // never opened on screen: no tsc on every stop of every session
      const plan = await planFor(wt, 'tsc');
      if (plan.skip) { stateOf(wt).tsc = { kind: 'tsc', status: 'skipped', reason: plan.skip, ms: 0 }; return; }
      return verify(wt, 'tsc');
    },
  });
  return service;
}
