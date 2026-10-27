import { describe, expect, it, vi } from 'vitest';
import * as contractModule from '../src/main/review/contract.js';
import { linkGraph } from '../src/main/graph/link.js';
import { createReviewService } from '../src/main/review/service.js';

const WT = '/w';
const PATCH = [
  'diff --git a/a.js b/a.js',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n');

function setup({ git = {}, files = {}, sessions = [], graph, extra = {} } = {}) {
  const calls = [];
  const timers = [];
  const gitMap = {
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': new Error('no upstream'),
    'rev-parse --abbrev-ref HEAD': 'feat/x\n',
    'merge-base HEAD origin/main': 'BASE\n',
    'diff --raw --numstat -z -M BASE': ':100644 100644 a b M\0a.js\x001\t1\ta.js\0',
    'ls-files --others --exclude-standard -z': '',
    'cat-file --batch': 'abc blob 1\nx\n',
    'diff -U3 BASE': PATCH,
    'diff -U3 HEAD': '',
    'diff -U3 BASE -- a.js': PATCH,
    'diff -U3 HEAD -- a.js': '',
    ...git,
  };
  const approvals = [];
  const service = createReviewService({
    git: async (args, cwd, input) => {
      expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false']);
      const key = args.slice(2).join(' ');
      calls.push({ key, cwd, input });
      const out = gitMap[key];
      if (out === undefined) throw new Error(`unexpected git ${key}`);
      if (out instanceof Error) throw out;
      return typeof out === 'function' ? out() : out;
    },
    readFile: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    stat: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return { mtimeMs: 1, size: files[p].length }; },
    graphFor: () => graph ?? null,
    verifier: { run: async (root, kind, plan) => { calls.push({ verify: kind, plan }); return { kind, status: 'ok', ms: 1 }; }, cancelAll() {} },
    storeFor: () => ({ load: async () => ({ approved: new Set(), prefs: {} }), approve: (id, on) => approvals.push([id, on]) }),
    sessionsOf: () => sessions,
    now: () => 0,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    cacheDir: '/cache',
    ...extra,
  });
  const fire = () => { for (const t of timers.splice(0)) t.fn?.(); };
  return { service, calls, fire, approvals, gitMap };
}

vi.mock('../src/main/review/contract.js', async (original) => {
  const actual = await original();
  return { ...actual, contractChanges: vi.fn(actual.contractChanges) };
});
const landed = (service) => new Promise((resolve) => service.once('changed', resolve));
const API = 'export function f(a) { return a; }\n';
const API_BEFORE = 'export function f(a, b) { return a + b; }\n';

describe('review service', () => {
  it('answers before the contract analysis: no merge-base read, the contract item pending, then it lands as a changed', async () => {
    const { service, calls } = setup({
      git: { 'cat-file --batch': `o blob ${API_BEFORE.length}\n${API_BEFORE}\n` },
      files: { '/w/a.js': API },
    });
    const done = landed(service);
    const first = await service.summary(WT);
    expect(first.contract).toEqual([]);
    expect(first.verdict.find((v) => v.key === 'contract')).toEqual({ key: 'contract', text: 'contrato: analisando…', tone: 'muted' });
    await done;
    expect(calls.filter((c) => c.key === 'cat-file --batch')).toHaveLength(1);
    const second = await service.summary(WT);
    expect(second.contract.map((c) => c.path)).toEqual(['a.js']);
    expect(second.files[0].contract).toBe(true);
    expect(second.verdict.find((v) => v.key === 'contract').text).toMatch(/mudança de contrato/);
  });

  it('does not start the analysis while paused, and starts it with the next summary after resume', async () => {
    const { service, calls } = setup({ files: { '/w/a.js': API }, extra: { startPaused: true } });
    await service.summary(WT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.some((c) => c.key === 'cat-file --batch')).toBe(false);
    service.resume();
    const done = landed(service);
    await service.summary(WT);
    await done;
    expect(calls.some((c) => c.key === 'cat-file --batch')).toBe(true);
  });

  it('orders a file with a changed export line first on a cold open, before any analysis', async () => {
    const two = ':100644 100644 a b M\0a.js\0:100644 100644 a b M\0b.js\x001\t1\ta.js\x001\t1\tb.js\0';
    const patch = (name, line) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n-old\n+${line}\n`;
    const { service } = setup({
      git: { 'diff --raw --numstat -z -M BASE': two, 'diff -U3 BASE': patch('a.js', 'const x = 1;') + patch('b.js', 'export function f() {}') },
      files: { '/w/a.js': 'y', '/w/b.js': 'z' },
    });
    expect((await service.summary(WT)).order).toEqual(['b.js', 'a.js']);
  });

  it('keeps the contract data when the graph arrives after a cold analysis, with no second analysis', async () => {
    let built = null;
    const { service, calls } = setup({
      git: { 'cat-file --batch': `o blob ${API_BEFORE.length}\n${API_BEFORE}\n` },
      files: { '/w/a.js': API },
      extra: { graphFor: () => ({ graph: () => built }), graphBuilt: () => built },
    });
    const done = landed(service);
    await service.summary(WT);
    await done;
    built = { modules: [{ id: 'a.js', functions: [] }], functions: [], imports: [], calls: [], edges: [], moduleEdges: [], callEdges: [] };
    const next = await service.summary(WT);
    expect(next.contract.map((c) => c.path)).toEqual(['a.js']);
    expect(next.verdict.find((v) => v.key === 'contract').text).toMatch(/mudança de contrato/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls.filter((c) => c.key === 'cat-file --batch')).toHaveLength(1);
  });

  it('shows a failed analysis as not verified, announces it, and does not retry the same file version', async () => {
    contractModule.contractChanges.mockImplementationOnce(() => { throw new Error('parser exploded'); });
    const { service } = setup({ files: { '/w/a.js': API } });
    const done = landed(service);
    await service.summary(WT);
    await done;
    const next = await service.summary(WT);
    const texts = next.verdict.map((v) => v.text);
    expect(texts).toContain('contrato: não verificado (parser exploded)');
    expect(texts.some((x) => /analisando/.test(x))).toBe(false);
    contractModule.contractChanges.mockClear();
    await service.summary(WT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(contractModule.contractChanges).not.toHaveBeenCalled();
  });

  it('does not reorder on an unrelated summary while the analysis is still pending', async () => {
    const two = ':100644 100644 a b M\0a.js\0:100644 100644 a b M\0b.js\x001\t1\ta.js\x001\t1\tb.js\0';
    let release;
    const { service } = setup({
      git: { 'diff --raw --numstat -z -M BASE': two, 'diff -U3 BASE': '', 'cat-file --batch': () => new Promise((resolve) => { release = () => resolve(`o blob 1\nx\no blob ${API_BEFORE.length}\n${API_BEFORE}\n`); }) },
      files: { '/w/a.js': 'y', '/w/b.js': API },
    });
    const first = (await service.summary(WT)).order;
    expect((await service.summary(WT)).order).toEqual(first);
    release();
  });

  it.each([[300, ['b.js', 'a.js']], [1500, ['a.js', 'b.js']]])('settles the provisional order only when the analysis lands within 1 s (at %i ms)', async (lateness, expected) => {
    const two = ':100644 100644 a b M\0a.js\0:100644 100644 a b M\0b.js\x001\t1\ta.js\x001\t1\tb.js\0';
    let clock = 0;
    const { service } = setup({
      git: { 'diff --raw --numstat -z -M BASE': two, 'diff -U3 BASE': '', 'cat-file --batch': `o blob 1\nx\no blob ${API_BEFORE.length}\n${API_BEFORE}\n` },
      files: { '/w/a.js': 'y', '/w/b.js': API },
      extra: { now: () => clock },
    });
    const done = landed(service);
    expect((await service.summary(WT)).order).toEqual(['a.js', 'b.js']);
    clock = lateness;
    await done;
    const second = await service.summary(WT);
    expect(second.contract.map((c) => c.path)).toEqual(['b.js']); // badges and verdict update either way
    expect(second.order).toEqual(expected);
    expect((await service.summary(WT)).order).toEqual(expected); // and it stays
  });

  it('reports a pt-BR baseError when no base candidate resolves', async () => {
    const err = new Error('bad ref');
    const { service } = setup({ git: { 'merge-base HEAD origin/main': err, 'merge-base HEAD main': err, 'merge-base HEAD origin/master': err, 'merge-base HEAD master': err } });
    const s = await service.summary(WT);
    expect(s.base).toBeNull();
    expect(s.baseError).toMatch(/base/i);
    expect(s.files).toEqual([]);
  });

  it('probes the fixed base candidates while it asks for the upstream, not one after the other', async () => {
    let probedWhileUpstreamRuns = false;
    const { service, calls } = setup({
      files: { '/w/a.js': 'x' },
      git: {
        'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': async () => {
          for (let tick = 0; tick < 20 && !calls.some((c) => c.key === 'merge-base HEAD origin/main'); tick++) await new Promise((resolve) => setTimeout(resolve, 0));
          probedWhileUpstreamRuns = calls.some((c) => c.key === 'merge-base HEAD origin/main');
          throw new Error('no upstream');
        },
      },
    });
    const s = await service.summary(WT);
    expect(probedWhileUpstreamRuns).toBe(true);
    expect(s.base).toBe('BASE');
  });

  it('never takes the current branch pushed as the base', async () => {
    const { service, calls } = setup({
      git: { 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': 'origin/feat/x\n', 'merge-base HEAD origin/feat/x': 'HEAD\n' },
      files: { '/w/a.js': 'x' },
    });
    const s = await service.summary(WT);
    expect(s.base).toBe('BASE');
    expect(calls.some((c) => c.key === 'merge-base HEAD origin/feat/x')).toBe(false);
  });

  it('lists files cheaply from one raw+numstat call, with the request from the source', async () => {
    const { service, calls } = setup({ files: { '/w/a.js': 'x' } });
    service.setRequestSource((wt) => ({ wt }));
    const s = await service.summary(WT);
    expect(s.base).toBe('BASE');
    expect(s.files[0]).toMatchObject({ path: 'a.js', status: 'modified', added: 1, removed: 1, binary: false, untracked: false });
    expect(s.order).toEqual(['a.js']);
    expect(s.request).toEqual({ wt: WT });
    expect(s.verdict.some((i) => i.key === 'tsc')).toBe(true);
    expect(calls.filter((c) => c.key?.startsWith('diff -U3')).map((c) => c.key).sort()).toEqual(['diff -U3 BASE', 'diff -U3 HEAD']);
  });

  it('asks for the HEAD hunk ids while the base diff is still running, not after it', async () => {
    let headSeenWhileBaseRuns = false;
    const { service, calls } = setup({
      files: { '/w/a.js': 'x' },
      git: {
        'diff -U3 BASE': async () => {
          for (let tick = 0; tick < 20 && !calls.some((c) => c.key === 'diff -U3 HEAD'); tick++) await new Promise((resolve) => setTimeout(resolve, 0));
          headSeenWhileBaseRuns = calls.some((c) => c.key === 'diff -U3 HEAD');
          return PATCH;
        },
      },
    });
    await service.summary(WT);
    expect(headSeenWhileBaseRuns).toBe(true);
  });

  it('asks for the HEAD hunk ids while the file list is still being read', async () => {
    let headSeenWhileListing = false;
    const { service, calls } = setup({
      files: { '/w/a.js': 'x' },
      git: {
        'diff --raw --numstat -z -M BASE': async () => {
          for (let tick = 0; tick < 20 && !calls.some((c) => c.key === 'diff -U3 HEAD'); tick++) await new Promise((resolve) => setTimeout(resolve, 0));
          headSeenWhileListing = calls.some((c) => c.key === 'diff -U3 HEAD');
          return ':100644 100644 a b M\0a.js\x001\t1\ta.js\0';
        },
      },
    });
    await service.summary(WT);
    expect(headSeenWhileListing).toBe(true);
    expect(calls.filter((c) => c.key === 'diff -U3 HEAD')).toHaveLength(1); // shared, not run twice
  });

  it('counts hunks from one full diff, prunes the store and serves file() warm', async () => {
    const pruned = [];
    const { service, calls } = setup({ files: { '/w/a.js': 'x' }, extra: { storeFor: () => ({ load: async () => ({ approved: new Set(), prefs: {} }), approve() {}, prune: (ids) => pruned.push(ids) }) } });
    const s = await service.summary(WT);
    expect(s.verdict.find((i) => i.key === 'review').text).toBe('revisado 0/1 hunks');
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toHaveLength(1);
    const before = calls.length;
    const f = await service.file(WT, 'a.js');
    expect(f.hunks).toHaveLength(1);
    expect(calls.length).toBe(before);
  });

  it('reads all merge-base texts through one cat-file --batch', async () => {
    const { service, calls } = setup({
      git: { 'diff --raw --numstat -z -M BASE': ':100644 100644 a b M\0a.js\0:100644 100644 a b M\0b.ts\x001\t1\ta.js\x001\t1\tb.ts\0', 'cat-file --batch': 'o blob 1\nx\no blob 3\nçz\n' },
      files: { '/w/a.js': 'x', '/w/b.ts': 'çz' },
    });
    await service.summary(WT);
    const batch = calls.filter((c) => c.key === 'cat-file --batch');
    expect(batch).toHaveLength(1);
    expect(batch[0].input).toBe('BASE:a.js\nBASE:b.ts\n');
    expect(calls.some((c) => c.key?.startsWith('show'))).toBe(false);
  });

  it('evicts cached patches of files that left the list', async () => {
    const { service, calls, gitMap } = setup({ files: { '/w/a.js': 'x' } });
    await service.summary(WT);
    gitMap['diff --raw --numstat -z -M BASE'] = '';
    await service.summary(WT);
    gitMap['diff --raw --numstat -z -M BASE'] = ':100644 100644 a b M\0a.js\x001\t1\ta.js\0';
    const before = calls.filter((c) => c.key === 'diff -U3 BASE').length;
    await service.summary(WT);
    expect(calls.filter((c) => c.key === 'diff -U3 BASE').length).toBe(before + 1);
  });

  it('shows untracked files as added', async () => {
    const { service } = setup({ git: { 'ls-files --others --exclude-standard -z': 'n.js\0' }, files: { '/w/a.js': 'x', '/w/n.js': 'one\ntwo\n' } });
    const s = await service.summary(WT);
    expect(s.files.find((f) => f.path === 'n.js')).toMatchObject({ status: 'added', untracked: true, added: 2, removed: 0 });
  });

  it('never reads an untracked file over the diff limit, and shows it too big', async () => {
    const read = [];
    const { service } = setup({
      git: { 'ls-files --others --exclude-standard -z': 'big.log\0' },
      files: { '/w/a.js': 'x' },
      extra: {
        readFile: async (p) => { read.push(p); if (p !== '/w/a.js') throw new Error('ENOENT'); return 'x'; },
        stat: async (p) => (p === '/w/big.log' ? { mtimeMs: 1, size: 50 * 1024 * 1024 } : p === '/w/a.js' ? { mtimeMs: 1, size: 1 } : Promise.reject(new Error('ENOENT'))),
      },
    });
    const s = await service.summary(WT);
    expect(s.files.find((f) => f.path === 'big.log')).toMatchObject({ status: 'added', untracked: true, added: null });
    const f = await service.file(WT, 'big.log');
    expect(f.tooBig).toBe(true);
    expect(read).not.toContain('/w/big.log');
  });

  it('reads an unchanged untracked file once across summaries and slices', async () => {
    const read = [];
    const files = { '/w/a.js': 'x', '/w/n.js': 'one\ntwo\n' };
    const graph = { modules: [], functions: [], imports: [], calls: [], edges: [], callEdges: [] };
    const { service } = setup({
      git: { 'ls-files --others --exclude-standard -z': 'n.js\0' },
      files,
      graph: { graph: () => graph },
      extra: { readFile: async (p) => { read.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p]; } },
    });
    await service.summary(WT);
    await service.summary(WT);
    await service.slice(WT, {});
    expect(read.filter((p) => p === '/w/n.js').length).toBeLessThanOrEqual(2);
    const before = read.filter((p) => p === '/w/n.js').length;
    await service.summary(WT);
    expect(read.filter((p) => p === '/w/n.js').length).toBe(before);
  });

  it('fills a file opened before the summary from the full diff, and caches by mtime and size', async () => {
    const { service, calls } = setup({ files: { '/w/a.js': 'x' } });
    const f = await service.file(WT, 'a.js');
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]).toMatchObject({ committed: true, approved: false });
    const diffs = calls.filter((c) => c.key?.startsWith('diff')).map((c) => c.key);
    expect(diffs).toEqual(['diff --raw --numstat -z -M BASE', 'diff -U3 BASE', 'diff -U3 HEAD']);
    const before = calls.length;
    await service.file(WT, 'a.js');
    expect(calls.length).toBe(before);
  });

  describe('reject', () => {
    const open = { 'diff -U3 HEAD': PATCH };

    it('refuses a hunk already in a commit', async () => {
      const { service } = setup({ files: { '/w/a.js': 'x' } });
      const f = await service.file(WT, 'a.js');
      expect(await service.reject(WT, 'a.js', f.hunks[0].id)).toEqual({ ok: false, error: 'já está num commit; comente pra o agente reverter' });
    });

    it('refuses while a session of the worktree is busy', async () => {
      const { service } = setup({ git: open, files: { '/w/a.js': 'x' }, sessions: [{ id: 's', status: 'working' }] });
      const f = await service.file(WT, 'a.js');
      expect(await service.reject(WT, 'a.js', f.hunks[0].id)).toEqual({ ok: false, error: 'espere o agente parar' });
    });

    it('reports a changed file when the reverse check fails', async () => {
      const { service } = setup({ git: { ...open, 'apply -R --check': new Error('does not apply') }, files: { '/w/a.js': 'x' }, sessions: [{ id: 's', status: 'done' }] });
      const f = await service.file(WT, 'a.js');
      expect(await service.reject(WT, 'a.js', f.hunks[0].id)).toEqual({ ok: false, error: 'o arquivo mudou; atualize' });
    });

    it('never touches a new (untracked) file', async () => {
      const { service, calls } = setup({ git: { 'diff -U3 BASE -- n.js': '', 'ls-files --others --exclude-standard -z -- n.js': 'n.js\0' }, files: { '/w/n.js': 'one\n' }, sessions: [] });
      const f = await service.file(WT, 'n.js');
      expect(await service.reject(WT, 'n.js', f.hunks[0].id)).toEqual({ ok: false, error: 'arquivo novo: peça pro agente apagar' });
      expect(calls.some((c) => c.key?.startsWith('apply'))).toBe(false);
    });

    it('re-emits the no-newline marker in the reverse patch', async () => {
      const real = 'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
      const { service, calls } = setup({ git: { ...open, 'diff -U3 BASE': real, 'diff -U3 HEAD': real, 'apply -R --check': '', 'apply -R': '' }, files: { '/w/a.js': 'x' }, sessions: [] });
      const f = await service.file(WT, 'a.js');
      expect((await service.reject(WT, 'a.js', f.hunks[0].id)).ok).toBe(true);
      expect(calls.find((c) => c.key === 'apply -R').input).toBe('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
    });

    it('applies the hunk patch in reverse through stdin', async () => {
      const { service, calls } = setup({ git: { ...open, 'apply -R --check': '', 'apply -R': '' }, files: { '/w/a.js': 'x' }, sessions: [{ id: 's', status: 'waiting' }] });
      const f = await service.file(WT, 'a.js');
      expect(await service.reject(WT, 'a.js', f.hunks[0].id)).toEqual({ ok: true });
      const applied = calls.find((c) => c.key === 'apply -R');
      expect(applied.input).toBe('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n');
      expect(calls.some((c) => c.key === 'apply -R --check' && c.input === applied.input)).toBe(true);
    });
  });

  describe('invalidate, pause and resume', () => {
    it('coalesces ten invalidations into one changed after 300 ms', () => {
      const { service, fire } = setup();
      const seen = [];
      service.on('changed', (wt) => seen.push(wt));
      for (let i = 0; i < 10; i++) service.invalidate(WT);
      fire();
      expect(seen).toEqual([WT]);
    });

    it('stays quiet while paused and emits one changed per dirty worktree on resume', () => {
      const { service, fire } = setup();
      const seen = [];
      service.on('changed', (wt) => seen.push(wt));
      service.pause();
      service.invalidate(WT);
      service.invalidate('/other');
      service.invalidate(WT);
      fire();
      expect(seen).toEqual([]);
      service.resume();
      fire();
      expect(seen.sort()).toEqual(['/other', WT]);
    });

    it('merges the flush on resume, an outside notice and a focus invalidate into one changed', () => {
      const { service, fire } = setup();
      const seen = [];
      service.on('changed', (wt) => seen.push(wt));
      service.pause();
      service.invalidate(WT);
      fire();
      service.resume();
      service.notify(WT);
      service.notify('/other');
      service.invalidate(WT);
      expect(seen).toEqual([]);
      fire();
      expect(seen.sort()).toEqual(['/other', WT]);
    });
  });

  it('onAgentStop runs the tsc plan through the verifier', async () => {
    const { service, calls } = setup({ files: { '/w/tsconfig.json': '{}', '/w/node_modules/.bin/tsc': '' } });
    await service.file(WT, 'a.js');
    await service.onAgentStop(WT);
    const run = calls.find((c) => c.verify === 'tsc');
    expect(run.plan.command).toBe('nice');
    expect(run.plan.args).toContain('--noEmit');
  });

  it('onAgentStop leaves alone a worktree the screen never asked about', async () => {
    const { service, calls } = setup({ files: { '/w/tsconfig.json': '{}', '/w/node_modules/.bin/tsc': '' } });
    await service.onAgentStop(WT);
    expect(calls.some((c) => c.verify)).toBe(false);
    await service.summary(WT);
    await service.onAgentStop(WT);
    expect(calls.filter((c) => c.verify === 'tsc')).toHaveLength(1);
  });

  it('can start paused, holding verifies until the first resume', async () => {
    const { service, calls } = setup({ files: { '/w/tsconfig.json': '{}', '/w/node_modules/.bin/tsc': '' }, extra: { startPaused: true } });
    const pending = service.verify(WT, 'tsc');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.some((c) => c.verify)).toBe(false);
    service.resume();
    expect((await pending).status).toBe('ok');
  });

  it('keeps only the last verify of a kind parked while paused', async () => {
    const { service, calls } = setup({ files: { '/w/tsconfig.json': '{}', '/w/node_modules/.bin/tsc': '', '/w/package.json': '{"scripts":{"test":"vitest"}}' } });
    service.pause();
    const first = service.verify(WT, 'tsc');
    const second = service.verify(WT, 'tsc');
    const tests = service.verify(WT, 'tests');
    const third = service.verify(WT, 'tsc');
    await new Promise((resolve) => setImmediate(resolve));
    service.resume();
    expect((await first).status).toBe('cancelled');
    expect((await second).status).toBe('cancelled');
    expect((await third).status).toBe('ok');
    expect((await tests).status).toBe('ok');
    expect(calls.filter((c) => c.verify === 'tsc')).toHaveLength(1);
    expect(calls.filter((c) => c.verify === 'tests')).toHaveLength(1);
  });

  it('logs why a summary failed before showing the short reason', async () => {
    const logged = [];
    const { service } = setup({ git: { 'diff --raw --numstat -z -M BASE': new Error('fatal: bad revision') }, extra: { log: (line) => logged.push(line) } });
    await service.summary(WT);
    expect(logged.join('\n')).toMatch(/fatal: bad revision/);
  });

  it('onAgentStop does not run a skipped tsc', async () => {
    const { service, calls } = setup();
    await service.onAgentStop(WT);
    expect(calls.some((c) => c.verify)).toBe(false);
  });

  it('compares a renamed file against its old path at the base', async () => {
    const same = 'export function f(a) { return a; }\n';
    const { service, calls } = setup({
      git: { 'diff --raw --numstat -z -M BASE': ':100644 100644 a b R100\0old.js\0new.js\x000\t0\t\0old.js\0new.js\0', 'diff -U3 BASE': '', 'cat-file --batch': `o blob ${same.length}\n${same}\n` },
      files: { '/w/new.js': same },
    });
    const s = await service.summary(WT);
    expect(calls.find((c) => c.key === 'cat-file --batch').input).toBe('BASE:old.js\n');
    expect(s.contract).toEqual([]);
    expect(s.files[0]).toMatchObject({ path: 'new.js', oldPath: 'old.js', status: 'renamed' });
  });

  it('opens a renamed file as renamed even before the summary, and the summary keeps it', async () => {
    const renamed = [
      'diff --git a/old.js b/new.js',
      'similarity index 90%',
      'rename from old.js',
      'rename to new.js',
      '--- a/old.js',
      '+++ b/new.js',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '',
    ].join('\n');
    const { service } = setup({
      git: {
        'diff --raw --numstat -z -M BASE': ':100644 100644 a b R090\0old.js\0new.js\x001\t1\t\0old.js\0new.js\0',
        'diff -U3 BASE': renamed,
        'diff -U3 BASE -- new.js': 'diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+keep\n+new\n',
        'cat-file --batch': 'o blob 9\nkeep\nold\n\n',
      },
      files: { '/w/new.js': 'keep\nnew\n' },
    });
    const f = await service.file(WT, 'new.js');
    expect(f.status).toBe('renamed');
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0].lines.map((l) => l.kind)).toEqual([' ', '-', '+']);
    await service.summary(WT);
    expect((await service.file(WT, 'new.js')).status).toBe('renamed');
  });

  it('lets the summary replace a one-path patch cached for a file outside the list', async () => {
    const { service, gitMap } = setup({
      git: {
        'diff --raw --numstat -z -M BASE': '',
        'diff -U3 BASE -- a.js': 'diff --git a/a.js b/a.js\nnew file mode 100644\n--- /dev/null\n+++ b/a.js\n@@ -0,0 +1 @@\n+new\n',
      },
      files: { '/w/a.js': 'x' },
    });
    expect((await service.file(WT, 'a.js')).status).toBe('added');
    gitMap['diff --raw --numstat -z -M BASE'] = ':100644 100644 a b M\0a.js\x001\t1\ta.js\0';
    await service.summary(WT);
    expect((await service.file(WT, 'a.js')).status).toBe('modified');
  });

  it('keeps the reading order of a file set when the graph arrives, and redoes it when the set changes', async () => {
    const ex = (id, calls = [], imports = [], withGo = true) => ({ functions: [{ id: `${id}#run`, name: 'run', startLine: 1, endLine: 5 }, ...(withGo ? [{ id: `${id}#go`, name: 'go', startLine: 6, endLine: 9 }] : [])], imports, calls });
    const graph = linkGraph(new Map([
      ['src/a.js', ex('src/a.js', [{ from: 'src/a.js#run', callee: { kind: 'local', name: 'go' } }], [{ from: './b.js', local: 'go', imported: 'go' }], false)],
      ['src/b.js', ex('src/b.js')],
      ['src/c.js', ex('src/c.js')],
    ]));
    let built = null;
    const two = ':100644 100644 a b M\0src/a.js\0:100644 100644 a b M\0src/b.js\x001\t1\tsrc/a.js\x001\t1\tsrc/b.js\0';
    const { service, gitMap } = setup({
      git: { 'diff --raw --numstat -z -M BASE': two, 'diff -U3 BASE': '', 'cat-file --batch': 'o blob 1\nx\no blob 1\nx\n' },
      files: { '/w/src/a.js': 'y', '/w/src/b.js': 'y', '/w/src/c.js': 'y' },
      extra: { graphFor: () => ({ graph: () => built }), graphBuilt: () => built },
    });
    const settled = landed(service);
    expect((await service.summary(WT)).order).toEqual(['src/a.js', 'src/b.js']);
    await settled;
    expect((await service.summary(WT)).order).toEqual(['src/a.js', 'src/b.js']);
    built = graph;
    expect((await service.summary(WT)).order).toEqual(['src/a.js', 'src/b.js']);
    gitMap['diff --raw --numstat -z -M BASE'] = `${two.slice(0, two.indexOf('1\t1'))}:100644 100644 a b M\0src/c.js\x00${two.slice(two.indexOf('1\t1'))}1\t1\tsrc/c.js\0`;
    gitMap['cat-file --batch'] = 'o blob 1\nx\no blob 1\nx\no blob 1\nx\n';
    expect((await service.summary(WT)).order).toEqual(['src/b.js', 'src/a.js', 'src/c.js']);
  });

  it('never throws out of summary when git fails (unborn HEAD, no repo)', async () => {
    const { service } = setup({ git: { 'diff --raw --numstat -z -M BASE': new Error('fatal: bad revision\nmore') } });
    const s = await service.summary(WT);
    expect(s.files).toEqual([]);
    expect(s.baseError).toBe('não deu pra ler as mudanças: fatal: bad revision');
  });

  it('asks the indexer to refresh once while a refresh is in flight', async () => {
    let calls = 0;
    const indexer = { graph: () => null, refresh: () => { calls++; return new Promise(() => {}); } };
    const { service } = setup({ graph: indexer });
    await service.slice(WT, {});
    await service.slice(WT, {});
    await service.slice(WT, {});
    expect(calls).toBe(1);
  });

  it('slice is building while the indexer has no graph yet', async () => {
    const indexer = { graph: () => null, refresh: () => new Promise(() => {}) };
    const { service } = setup({ graph: indexer });
    expect(await service.slice(WT, {})).toEqual({ status: 'building', done: 0, total: 0 });
  });

  it('slice is unavailable when the indexer says so', async () => {
    const { service } = setup({ graph: { graph: () => ({ unavailable: 'sem git neste projeto' }) } });
    expect(await service.slice(WT, {})).toEqual({ status: 'unavailable', reason: 'sem git neste projeto' });
  });

  it('works out the changed functions once per file version and graph, not on every summary or slice', async () => {
    let lookups = 0;
    const modules = Object.assign([{ id: 'a.js', functions: [] }], { find(...args) { lookups++; return Array.prototype.find.apply(this, args); } });
    const graph = { modules, functions: [], imports: [], calls: [], edges: [] };
    const { service } = setup({ files: { '/w/a.js': 'new' }, graph: { graph: () => graph } });
    await service.summary(WT);
    await landed(service);
    await service.summary(WT);
    const first = lookups;
    expect(first).toBeGreaterThan(0);
    await service.summary(WT);
    await service.slice(WT, {});
    expect(lookups).toBe(first);
  });

  it('starts a cold graph only after the summary is worked out, and looks without starting while it works', async () => {
    const order = [];
    const indexer = { graph: () => null, refresh: () => new Promise(() => {}) };
    const { service, calls } = setup({
      files: { '/w/a.js': 'new' },
      extra: { graphFor: () => { order.push(`graphFor after ${calls.length} git calls`); return indexer; }, graphBuilt: () => null },
    });
    await service.summary(WT);
    expect(order).toEqual([`graphFor after ${calls.length} git calls`]);
  });

  it('still starts the cold graph when the summary work throws', async () => {
    let started = 0;
    const indexer = { graph: () => null, refresh: () => new Promise(() => {}) };
    const { service } = setup({
      git: { 'diff -U3 BASE': new Error('boom') },
      files: { '/w/a.js': 'new' },
      extra: { graphFor: () => { started++; return indexer; }, graphBuilt: () => null },
    });
    const s = await service.summary(WT);
    expect(s.baseError).toMatch(/não deu pra ler/);
    expect(started).toBe(1);
  });
});

describe('a task step\'s diff', () => {
  const NEW_FILE = ['diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n');
  const withSteps = (diff, refs = { 0: 'r/0', 1: 'r/1' }) => {
    const diffs = [];
    const { service, calls } = setup({
      extra: { checkpoints: { diff: async (...args) => { diffs.push(args); return diff; } }, stepRefsOf: () => refs },
    });
    return { service, calls, diffs };
  };

  it('reads checkpoint n-1 against n, parsed, with a new file', async () => {
    const { service, diffs } = withSteps(NEW_FILE);
    const out = await service.stepDiff(WT, 5, 1);
    expect(diffs).toEqual([[WT, 'r/0', 'r/1']]);
    expect(out.together).toBe(false);
    expect(out.files[0]).toMatchObject({ path: 'n.js', status: 'added', added: 2, removed: 0 });
  });

  it('an empty step is flagged as ticked together', async () => {
    const { service } = withSteps('');
    expect(await service.stepDiff(WT, 5, 1)).toEqual({ n: 1, files: [], together: true });
  });

  it('says so when the step has no checkpoint, and never runs git on the summary path', async () => {
    const { service, calls, diffs } = withSteps(NEW_FILE, { 0: 'r/0' });
    expect(await service.stepDiff(WT, 5, 1)).toEqual({ error: 'esse passo ainda não tem ponto de controle' });
    expect(await service.stepDiff(WT, 5, 0)).toEqual({ error: 'passo inválido' });
    await service.summary(WT);
    expect(diffs).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });
});
