import { describe, it, expect } from 'vitest';
import { prepareWorktree } from '../src/main/automations/worktree.js';

const a = { slug: 'varredura' };
const now = () => new Date(2026, 9, 27, 9, 5);
function fake({ refs = ['origin/main', 'main'], present = false, dirty = '', failOn } = {}) {
  const calls = [];
  const git = async (args, { cwd }) => {
    calls.push({ args, cwd });
    const cmd = args.join(' ');
    if (failOn && cmd.startsWith(failOn)) return { code: 1, stdout: '' };
    if (args[0] === 'rev-parse') return { code: refs.some((r) => args[3].startsWith(`${r}^`)) ? 0 : 1, stdout: '' };
    if (args[0] === 'status') return { code: 0, stdout: dirty };
    return { code: 0, stdout: '' };
  };
  return { calls, opts: { git, exists: async () => present, repoRoot: '/work/vizor', home: '/home/m', now } };
}

describe('prepareWorktree', () => {
  it('adds a sibling worktree on a new auto/<slug>/<stamp> branch from origin/main', async () => {
    const { calls, opts } = fake();
    const r = await prepareWorktree(a, opts);
    expect(r).toEqual({ ok: true, path: '/work/vizor-auto-varredura', branch: 'auto/varredura/20261027-0905', base: 'origin/main' });
    expect(calls.at(-1)).toEqual({ args: ['worktree', 'add', '-b', 'auto/varredura/20261027-0905', '/work/vizor-auto-varredura', 'origin/main'], cwd: '/work/vizor' });
  });
  it('falls back to main when origin/main is missing', async () => {
    const { opts } = fake({ refs: ['main'] });
    expect((await prepareWorktree(a, opts)).base).toBe('main');
  });
  it('reuses a clean worktree with a fresh branch', async () => {
    const { calls, opts } = fake({ present: true });
    const r = await prepareWorktree(a, opts);
    expect(r.ok).toBe(true);
    expect(calls.at(-1)).toEqual({ args: ['checkout', '-b', 'auto/varredura/20261027-0905', 'origin/main'], cwd: '/work/vizor-auto-varredura' });
  });
  it('refuses a worktree with uncommitted changes', async () => {
    const { calls, opts } = fake({ present: true, dirty: ' M a.js\n' });
    const r = await prepareWorktree(a, opts);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/não commitadas/);
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false);
  });
  it('refuses paths the guard would refuse (/, home, .claude)', async () => {
    for (const repoRoot of ['/vizor', '/home/m/x', '/home/.claude/proj']) {
      const { opts } = fake();
      const r = await prepareWorktree(a, { ...opts, repoRoot: repoRoot === '/home/m/x' ? '/home/m/x' : repoRoot, home: repoRoot === '/vizor' ? '/vizor-auto-varredura' : '/home/m' });
      if (repoRoot === '/home/m/x') expect(r.ok).toBe(true);
      else expect(r.status).toBe('failed');
    }
  });
  it('fails with a reason when git fails or no base exists', async () => {
    expect((await prepareWorktree(a, fake({ refs: [] }).opts)).status).toBe('failed');
    expect((await prepareWorktree(a, fake({ failOn: 'worktree add' }).opts)).status).toBe('failed');
  });
});
