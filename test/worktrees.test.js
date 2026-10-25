import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listWorktrees, parseWorktreeList, repoRootOf, worktreeRootOf } from '../src/main/worktrees.js';

const FIXTURE = `worktree /r/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /r/wt-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/x

worktree /r/wt-detached
HEAD 3333333333333333333333333333333333333333
detached

worktree /r/wt-gone
HEAD 4444444444444444444444444444444444444444
branch refs/heads/old
prunable gitdir file points to non-existent location
`;

describe('parseWorktreeList', () => {
  it('reads main, linked, detached and prunable worktrees', () => {
    const list = parseWorktreeList(FIXTURE);
    expect(list.map((wt) => wt.path)).toEqual(['/r/main', '/r/wt-x', '/r/wt-detached', '/r/wt-gone']);
    expect(list.map((wt) => wt.branch)).toEqual(['main', 'feat/x', null, 'old']);
    expect(list[2]).toMatchObject({ detached: true, head: '3333333333333333333333333333333333333333' });
    expect(list[3].prunable).toBe(true);
    expect(list[0]).toMatchObject({ detached: false, bare: false, prunable: false });
  });
});

describe('git worktrees on disk', () => {
  let repo;
  let linked;
  let mainBranch;
  const real = (dir) => fs.realpathSync(dir);

  beforeAll(async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'cm-wt-'));
    repo = path.join(base, 'repo');
    linked = path.join(base, 'wt');
    await mkdir(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    await writeFile(path.join(repo, 'f.txt'), 'x');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    mainBranch = git('branch', '--show-current').trim();
    git('worktree', 'add', '-q', linked, '-b', 'feat/y');
    await mkdir(path.join(linked, 'sub'));
  });

  it('lists the main worktree first, then the linked one', async () => {
    const list = await listWorktrees(repo);
    expect(list.map((wt) => wt.branch)).toEqual([mainBranch, 'feat/y']);
    expect(real(list[1].path)).toBe(real(linked));
  });

  it('resolves a linked worktree subfolder to its main repo', async () => {
    expect(real(await repoRootOf(path.join(linked, 'sub')))).toBe(real(repo));
  });

  it('treats a non-git folder as a single pseudo-worktree', async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), 'cm-plain-'));
    expect(await listWorktrees(plain)).toEqual([
      { path: plain, branch: null, head: null, detached: false, bare: false, prunable: false },
    ]);
    expect(await repoRootOf(plain)).toBeNull();
  });

  it('resolves a folder to its OWN worktree root, linked ones included (#94 review)', async () => {
    expect(real(await worktreeRootOf(path.join(linked, 'sub')))).toBe(real(linked));
    expect(real(await worktreeRootOf(repo))).toBe(real(repo));
    expect(await worktreeRootOf(os.tmpdir())).toBeNull();
  });
});
