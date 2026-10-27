import { describe, expect, it } from 'vitest';
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
      return out;
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

describe('review service', () => {
  it('reports a pt-BR baseError when no base candidate resolves', async () => {
    const err = new Error('bad ref');
    const { service } = setup({ git: { 'merge-base HEAD origin/main': err, 'merge-base HEAD main': err, 'merge-base HEAD origin/master': err, 'merge-base HEAD master': err } });
    const s = await service.summary(WT);
    expect(s.base).toBeNull();
    expect(s.baseError).toMatch(/base/i);
    expect(s.files).toEqual([]);
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
    expect(calls.filter((c) => c.key?.startsWith('diff -U3')).map((c) => c.key)).toEqual(['diff -U3 BASE', 'diff -U3 HEAD']);
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

  it('asks the patch only for the requested file and caches by mtime and size', async () => {
    const { service, calls } = setup({ files: { '/w/a.js': 'x' } });
    const f = await service.file(WT, 'a.js');
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]).toMatchObject({ committed: true, approved: false });
    const diffs = calls.filter((c) => c.key?.startsWith('diff')).map((c) => c.key);
    expect(diffs).toEqual(['diff -U3 BASE -- a.js', 'diff -U3 HEAD -- a.js']);
    const before = calls.length;
    await service.file(WT, 'a.js');
    expect(calls.length).toBe(before);
  });

  describe('reject', () => {
    const open = { 'diff -U3 HEAD -- a.js': PATCH };

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
      const { service, calls } = setup({ git: { ...open, 'diff -U3 BASE -- a.js': real, 'diff -U3 HEAD -- a.js': real, 'apply -R --check': '', 'apply -R': '' }, files: { '/w/a.js': 'x' }, sessions: [] });
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
      expect(seen.sort()).toEqual(['/other', WT]);
    });
  });

  it('onAgentStop runs the tsc plan through the verifier', async () => {
    const { service, calls } = setup({ files: { '/w/tsconfig.json': '{}', '/w/node_modules/.bin/tsc': '' } });
    await service.onAgentStop(WT);
    const run = calls.find((c) => c.verify === 'tsc');
    expect(run.plan.command).toBe('nice');
    expect(run.plan.args).toContain('--noEmit');
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
