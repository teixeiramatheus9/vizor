import { describe, it, expect } from 'vitest';
import { cliArgs, guardRules } from '../src/main/automations/permissions.js';

const base = { id: 'a1', slug: 'varredura', model: 'sonnet', capUsd: 1, timeoutMin: 15 };
const flag = (args, name) => args[args.indexOf(name) + 1];
const list = (args, name) => flag(args, name).split(',');

describe('cliArgs', () => {
  it('read level: dontAsk, read-only allowlist, exact flags', () => {
    const args = cliArgs({ ...base, level: 'read' }, {});
    expect(args.slice(0, 2)).toEqual(['-p', '/vizor-varredura']);
    expect(flag(args, '--output-format')).toBe('json');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    expect(flag(args, '--max-budget-usd')).toBe('1');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(list(args, '--allowedTools')).toEqual([
      'Read', 'Grep', 'Glob', 'Skill',
      'Bash(git log*)', 'Bash(git diff*)', 'Bash(git status*)', 'Bash(git show*)',
      'Bash(gh issue list*)', 'Bash(gh issue view*)',
      'Bash(gh pr list*)', 'Bash(gh pr view*)', 'Bash(gh pr checks*)', 'Bash(gh pr diff*)',
    ]);
    const denied = list(args, '--disallowedTools');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(git commit*)', 'Bash(git push*)', 'Bash(git merge*)', 'Bash(gh pr merge*)', 'Bash(gh issue create*)']) {
      expect(denied).toContain(t);
    }
  });

  it('worktree level: acceptEdits plus edit and commit, still no gh writes', () => {
    const args = cliArgs({ ...base, level: 'worktree' }, {});
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    const allowed = list(args, '--allowedTools');
    for (const t of ['Edit', 'Write', 'Bash(git add*)', 'Bash(git commit*)']) expect(allowed).toContain(t);
    expect(allowed).not.toContain('Bash(gh issue create*)');
    const denied = list(args, '--disallowedTools');
    expect(denied).toContain('Bash(gh pr comment*)');
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Bash(git commit*)');
  });

  it('project level: adds the gh that writes, but never push, merge or branch delete', () => {
    const args = cliArgs({ ...base, level: 'project' }, {});
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    const allowed = list(args, '--allowedTools');
    for (const t of ['Bash(gh issue create*)', 'Bash(gh issue comment*)', 'Bash(gh pr comment*)']) expect(allowed).toContain(t);
    expect(list(args, '--disallowedTools')).toEqual(
      expect.arrayContaining(['Bash(git push*)', 'Bash(git merge*)', 'Bash(gh pr merge*)', 'Bash(git branch -D*)']),
    );
  });

  it('never bypassPermissions nor --setting-sources, at any level', () => {
    for (const level of ['read', 'worktree', 'project']) {
      const args = cliArgs({ ...base, level }, { testCmd: 'npm test' });
      expect(args.join(' ')).not.toMatch(/bypassPermissions|dangerously/i);
      expect(args).not.toContain('--setting-sources');
    }
  });

  it('adds test and lint as Bash(<cmd>*) only when present', () => {
    const none = list(cliArgs({ ...base, level: 'read' }, {}), '--allowedTools');
    expect(none.some((t) => t.includes('npm'))).toBe(false);
    const both = list(cliArgs({ ...base, level: 'read' }, { testCmd: 'npm test', lintCmd: 'npm run lint' }), '--allowedTools');
    expect(both).toContain('Bash(npm test*)');
    expect(both).toContain('Bash(npm run lint*)');
  });

  it('drops a command that would break the allowlist syntax', () => {
    const allowed = list(cliArgs({ ...base, level: 'read' }, { testCmd: 'a,b', lintCmd: 'x) && (rm' }), '--allowedTools');
    expect(allowed.some((t) => t.includes('a,b') || t.includes('rm'))).toBe(false);
  });

  it('uses a custom prompt, and the cap and model of the automação', () => {
    const args = cliArgs({ ...base, level: 'read', capUsd: 2.5, model: 'haiku' }, { prompt: '/vizor-x oi' });
    expect(args[1]).toBe('/vizor-x oi');
    expect(flag(args, '--max-budget-usd')).toBe('2.5');
    expect(flag(args, '--model')).toBe('haiku');
  });
});

describe('guardRules', () => {
  const always = ['git push', 'git merge', '--force', 'gh pr merge'];
  it('read: denies edits and gh writes', () => {
    expect(guardRules({ ...base, level: 'read' }, {})).toEqual({
      id: 'a1', level: 'read', denyAlways: always, denyGhWrite: true, denyEdits: true, allowEditsUnder: null,
    });
  });
  it('worktree: edits only under the worktree', () => {
    expect(guardRules({ ...base, level: 'worktree' }, { worktreePath: '/r-auto-varredura' })).toEqual({
      id: 'a1', level: 'worktree', denyAlways: always, denyGhWrite: true, denyEdits: false, allowEditsUnder: '/r-auto-varredura',
    });
  });
  it('worktree without a path fails closed', () => {
    const r = guardRules({ ...base, level: 'worktree' }, {});
    expect(r.denyEdits).toBe(true);
    expect(r.allowEditsUnder).toBeNull();
  });
  it('project: edits and gh writes allowed, push still denied', () => {
    expect(guardRules({ ...base, level: 'project' }, {})).toEqual({
      id: 'a1', level: 'project', denyAlways: always, denyGhWrite: false, denyEdits: false, allowEditsUnder: null,
    });
  });
});
