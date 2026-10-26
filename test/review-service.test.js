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
    'diff --numstat -z -M BASE': '1\t1\ta.js\0',
    'diff --name-status -z -M BASE': 'M\0a.js\0',
    'ls-files --others --exclude-standard -z': '',
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

  it('lists files cheaply from numstat and name-status, with the request from the source', async () => {
    const { service, calls } = setup({ files: { '/w/a.js': 'x' } });
    service.setRequestSource((wt) => ({ wt }));
    const s = await service.summary(WT);
    expect(s.base).toBe('BASE');
    expect(s.files[0]).toMatchObject({ path: 'a.js', status: 'modified', added: 1, removed: 1, binary: false, untracked: false });
    expect(s.order).toEqual(['a.js']);
    expect(s.request).toEqual({ wt: WT });
    expect(s.verdict.some((i) => i.key === 'tsc')).toBe(true);
    expect(calls.some((c) => c.key?.startsWith('diff -U3'))).toBe(false);
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

  it('slice is building while the indexer has no graph yet', async () => {
    const indexer = { graph: () => null, refresh: () => new Promise(() => {}) };
    const { service } = setup({ graph: indexer });
    expect(await service.slice(WT, {})).toEqual({ status: 'building', done: 0, total: 0 });
  });

  it('slice is unavailable when the indexer says so', async () => {
    const { service } = setup({ graph: { graph: () => ({ unavailable: 'sem git neste projeto' }) } });
    expect(await service.slice(WT, {})).toEqual({ status: 'unavailable', reason: 'sem git neste projeto' });
  });
});
