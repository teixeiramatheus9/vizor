import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCheckpoints, execGit } from '../src/main/work/checkpoints.js';

describe('createCheckpoints (injected git)', () => {
  const wt = createHash('sha1').update('/w/app').digest('hex').slice(0, 12);
  const setup = (impl) => {
    const calls = [];
    const git = vi.fn(async (args, opts) => {
      calls.push({ args, ...opts });
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/w/app\n';
      return impl ? impl(args, opts) : '';
    });
    const mkTemp = vi.fn(async () => '/tmp/vz-x');
    const rm = vi.fn(async () => {});
    return { calls, git, mkTemp, rm, cp: createCheckpoints({ git, mkTemp, rm, realpath: async (p) => p }) };
  };

  it('builds the tree through a temporary index outside the worktree and removes it', async () => {
    const { calls, cp, rm } = setup((args) => (args[0] === 'write-tree' ? 'tree1\n' : args[0] === 'commit-tree' ? 'sha1\n' : 'headsha\n'));
    const out = await cp.take('/w/app', 169, 2);
    expect(out).toEqual({ ref: `refs/vizor/tarefa/${wt}/169/2`, sha: 'sha1' });
    const indexed = calls.filter((c) => c.env?.GIT_INDEX_FILE);
    expect(indexed.map((c) => c.args[0])).toEqual(['read-tree', 'add', 'write-tree', 'commit-tree']);
    expect(indexed.every((c) => c.env.GIT_INDEX_FILE === '/tmp/vz-x/index')).toBe(true);
    expect(calls.find((c) => c.args[0] === 'update-ref').args).toEqual(['update-ref', `refs/vizor/tarefa/${wt}/169/2`, 'sha1']);
    expect(rm).toHaveBeenCalledWith('/tmp/vz-x');
  });

  it('removes the temporary index even when git fails', async () => {
    const { cp, rm } = setup((args) => { if (args[0] === 'add') throw new Error('boom'); return 'x\n'; });
    await expect(cp.take('/w/app', 1, 1)).rejects.toThrow('boom');
    expect(rm).toHaveBeenCalled();
  });

  it('refuses a repository without commits with a pt-BR reason', async () => {
    const { cp, mkTemp } = setup((args) => { if (args[0] === 'rev-parse') throw new Error('no head'); return ''; });
    await expect(cp.take('/w/app', 1, 1)).rejects.toThrow(/não tem commits/);
    expect(mkTemp).not.toHaveBeenCalled();
  });

  it('validates issue and n as positive integers', async () => {
    const { cp, git } = setup();
    for (const [i, n] of [[0, 1], [1, 0], [-1, 1], [1.5, 1], ['1/../x', 1], [1, 'a'], [NaN, 1]]) {
      await expect(cp.take('/w/app', i, n)).rejects.toThrow(/inválid/);
    }
    await expect(cp.drop('/w/app', 'x')).rejects.toThrow(/inválid/);
    expect(git).not.toHaveBeenCalled();
  });

  it('refuses a relative worktree, a foreign ref and a missing toRef', async () => {
    const { cp } = setup();
    await expect(cp.take('rel/path', 1, 1)).rejects.toThrow(/inválid/);
    await expect(cp.restore('/w/app', 'refs/heads/main')).rejects.toThrow(/inválid/);
    await expect(cp.restore('/w/app', 'refs/vizor/tarefa/1/1')).rejects.toThrow(/inválid/);
    await expect(cp.restore('/w/../etc', `refs/vizor/tarefa/${wt}/1/1`)).rejects.toThrow(/inválid/);
    await expect(cp.diff('/w/app', null, undefined)).rejects.toThrow(/inválid/);
  });

  it('drop deletes only the refs under its own worktree and issue', async () => {
    const { calls, cp } = setup((args) => (args[0] === 'for-each-ref' ? `refs/vizor/tarefa/${wt}/7/1\nrefs/vizor/tarefa/${wt}/7/2\n` : ''));
    await cp.drop('/w/app', 7);
    expect(calls.find((c) => c.args[0] === 'for-each-ref').args.at(-1)).toBe(`refs/vizor/tarefa/${wt}/7/`);
    expect(calls.filter((c) => c.args[0] === 'update-ref').map((c) => c.args)).toEqual([
      ['update-ref', '-d', `refs/vizor/tarefa/${wt}/7/1`], ['update-ref', '-d', `refs/vizor/tarefa/${wt}/7/2`],
    ]);
  });
});

describe('createCheckpoints (real git)', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vz-cp-'));
    dirs.push(dir);
    g(dir, 'init', '-q');
    g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init');
    return dir;
  };
  const cp = () => createCheckpoints({ git: execGit });

  it('a new file shows up in the checkpoint, and ignored files do not', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'new.txt'), 'hello\n');
    writeFileSync(join(dir, 'ignored.txt'), 'no\n');
    const { ref } = await cp().take(dir, 5, 1);
    const files = g(dir, 'ls-tree', '-r', '--name-only', ref).split('\n');
    expect(files).toContain('new.txt');
    expect(files).not.toContain('ignored.txt');
  });

  it("leaves the dev's index byte for byte as it was", async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    g(dir, 'add', 'a.txt');
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    const before = [g(dir, 'diff', '--cached'), g(dir, 'status', '--porcelain'), readFileSync(join(dir, '.git', 'index'))];
    await cp().take(dir, 5, 1);
    expect([g(dir, 'diff', '--cached'), g(dir, 'status', '--porcelain'), readFileSync(join(dir, '.git', 'index'))]).toEqual(before);
  });

  it('restore brings the content back and never deletes a later file', async () => {
    const dir = repo();
    const c = cp();
    writeFileSync(join(dir, 'a.txt'), 'step1\n');
    const { ref } = await c.take(dir, 5, 1);
    writeFileSync(join(dir, 'a.txt'), 'step2\n');
    writeFileSync(join(dir, 'later.txt'), 'later\n');
    const out = await c.restore(dir, ref);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('step1\n');
    expect(existsSync(join(dir, 'later.txt'))).toBe(true);
    expect(out.restored).toEqual(['a.txt']);
    expect(out.left).toEqual(['later.txt']);
  });

  it('two equal checkpoints give an empty diff; a change shows in the patch', async () => {
    const dir = repo();
    const c = cp();
    const one = await c.take(dir, 5, 1);
    const two = await c.take(dir, 5, 2);
    expect(await c.diff(dir, one.ref, two.ref)).toBe('');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const three = await c.take(dir, 5, 3);
    expect(await c.diff(dir, two.ref, three.ref)).toContain('+changed');
    expect(await c.diff(dir, null, three.ref)).toContain('+changed');
  });

  it('drop removes the refs, and a repo without commits is refused', async () => {
    const dir = repo();
    const c = cp();
    await c.take(dir, 5, 1); await c.take(dir, 6, 1);
    await c.drop(dir, 5);
    expect(g(dir, 'for-each-ref', 'refs/vizor/').trim().split('\n')).toHaveLength(1);
    const empty = mkdtempSync(join(tmpdir(), 'vz-cp-')); dirs.push(empty);
    g(empty, 'init', '-q');
    mkdirSync(join(empty, 'x'));
    await expect(c.take(empty, 1, 1)).rejects.toThrow(/não tem commits/);
  });

  it('a file deleted after the checkpoint comes back and is listed as restored', async () => {
    const dir = repo();
    const c = cp();
    const { ref } = await c.take(dir, 5, 1);
    rmSync(join(dir, 'a.txt'));
    const out = await c.restore(dir, ref);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(out).toEqual({ restored: ['a.txt'], left: [] });
  });

  it('lists non-ASCII names raw, not C-quoted', async () => {
    const dir = repo();
    const c = cp();
    mkdirSync(join(dir, 'd d'));
    writeFileSync(join(dir, 'é ü.txt'), '1\n');
    writeFileSync(join(dir, 'd d', 'ñ.txt'), '1\n');
    const { ref } = await c.take(dir, 5, 1);
    writeFileSync(join(dir, 'é ü.txt'), '2\n');
    writeFileSync(join(dir, 'd d', 'ñ.txt'), '2\n');
    writeFileSync(join(dir, 'ç novo.txt'), 'x\n');
    const out = await c.restore(dir, ref);
    expect(out.restored.sort()).toEqual(['d d/ñ.txt', 'é ü.txt']);
    expect(out.left).toEqual(['ç novo.txt']);
  });

  it('a linked worktree with the same issue neither collides nor loses refs to drop', async () => {
    const main = repo();
    const linked = join(mkdtempSync(join(tmpdir(), 'vz-cp-')), 'wt');
    dirs.push(join(linked, '..'));
    g(main, 'worktree', 'add', '-q', '-b', 'other', linked);
    const c = cp();
    const a = await c.take(main, 9, 1);
    const b = await c.take(linked, 9, 1);
    expect(a.ref).not.toBe(b.ref);
    await c.drop(main, 9);
    const left = g(main, 'for-each-ref', '--format=%(refname)', 'refs/vizor/').trim().split('\n');
    expect(left).toEqual([b.ref]);
    await expect(c.restore(main, b.ref)).rejects.toThrow(/inválid/);
  });

  it('refuses a subdirectory of the repo with a pt-BR reason', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    await expect(cp().take(join(dir, 'sub'), 1, 1)).rejects.toThrow(/raiz do repositório/);
  });
});
