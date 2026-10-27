import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cliArgs, guardRules, runEnv } from '../src/main/automations/permissions.js';

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
      ...['git log', 'git diff', 'git status', 'git show', 'gh issue list', 'gh issue view', 'gh pr list', 'gh pr view', 'gh pr checks', 'gh pr diff']
        .flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    ]);
    const denied = list(args, '--disallowedTools');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(git commit *)', 'Bash(git push *)', 'Bash(git merge *)', 'Bash(gh pr merge *)', 'Bash(gh issue create *)']) {
      expect(denied).toContain(t);
    }
  });

  it('worktree level: acceptEdits plus edit and commit, still no gh writes', () => {
    const args = cliArgs({ ...base, level: 'worktree' }, {});
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    const allowed = list(args, '--allowedTools');
    for (const t of ['Bash(git add *)', 'Bash(git commit *)']) expect(allowed).toContain(t);
    expect(allowed).not.toContain('Edit');
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Bash(gh issue create *)');
    const denied = list(args, '--disallowedTools');
    expect(denied).toContain('Bash(gh pr comment *)');
    expect(denied).not.toContain('Edit');
    expect(denied).not.toContain('Bash(git commit *)');
  });

  it('project level: adds the gh that writes, but never push, merge or branch delete', () => {
    const args = cliArgs({ ...base, level: 'project' }, {});
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    const allowed = list(args, '--allowedTools');
    for (const t of ['Bash(gh issue create *)', 'Bash(gh issue comment *)', 'Bash(gh pr comment *)']) expect(allowed).toContain(t);
    expect(list(args, '--disallowedTools')).toEqual(
      expect.arrayContaining(['Bash(git push *)', 'Bash(git merge *)', 'Bash(gh pr merge *)', 'Bash(git branch -D *)', 'Bash(git reset --hard *)', 'Bash(git clean -f *)', 'Bash(git push --force-with-lease *)']),
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
    for (const t of ['Bash(npm test)', 'Bash(npm test *)', 'Bash(npm run lint)', 'Bash(npm run lint *)']) expect(both).toContain(t);
  });

  it('drops a command that would break the allowlist syntax', () => {
    const allowed = list(cliArgs({ ...base, level: 'read' }, { testCmd: 'a,b', lintCmd: 'x) && (rm' }), '--allowedTools');
    expect(allowed.some((t) => t.includes('a,b') || t.includes('rm'))).toBe(false);
  });

  it('rejects test/lint commands with shell metacharacters', () => {
    for (const bad of ['npm test; rm -rf /', 'npm test $(id)', 'npm test `id`', 'a && b', 'a | b', 'a\nb']) {
      const allowed = list(cliArgs({ ...base, level: 'read' }, { testCmd: bad }), '--allowedTools');
      expect(allowed.some((t) => t.includes('npm test') || t.includes('a &&'))).toBe(false);
    }
  });

  it('does not let a prefix match a longer command, and blocks git --output', () => {
    const args = cliArgs({ ...base, level: 'read' }, { testCmd: 'npm test' });
    expect(list(args, '--allowedTools').some((t) => /\*\)$/.test(t) && !/ \*\)$/.test(t))).toBe(false);
    expect(list(args, '--disallowedTools')).toEqual(expect.arrayContaining(['Bash(git diff *--output*)', 'Bash(git log *--output*)', 'Bash(git show *--output*)']));
  });

  it('denies edits to the Claude config out of tree when edits are allowed', () => {
    const denied = list(cliArgs({ ...base, level: 'worktree' }, {}), '--disallowedTools');
    expect(denied).toEqual(expect.arrayContaining(['Edit(~/.claude/**)', 'Write(~/.claude/**)']));
  });

  it('refuses a bad prompt, cap or model', () => {
    expect(() => cliArgs({ ...base, level: 'read' }, { prompt: '--dangerously-skip-permissions' })).toThrow();
    expect(() => cliArgs({ ...base, level: 'read', capUsd: 0 })).toThrow();
    expect(() => cliArgs({ ...base, level: 'read', capUsd: NaN })).toThrow();
    expect(() => cliArgs({ ...base, level: 'read', model: 'x --y' })).toThrow();
    expect(() => cliArgs({ ...base, level: 'read', model: 'claude-opus-5-5[1m]' })).not.toThrow();
  });

  it('uses a custom prompt, and the cap and model of the automação', () => {
    const args = cliArgs({ ...base, level: 'read', capUsd: 2.5, model: 'haiku' }, { prompt: '/vizor-x oi' });
    expect(args[1]).toBe('/vizor-x oi');
    expect(flag(args, '--max-budget-usd')).toBe('2.5');
    expect(flag(args, '--model')).toBe('haiku');
  });
});

describe('guardRules', () => {
  const programs = (r) => r.allowBash.map((e) => [e.program, ...(e.sub ?? e.argsPrefix ?? [])].join(' '));
  it('read: no edits, reads only', () => {
    const r = guardRules({ ...base, level: 'read' }, { worktreePath: '/r-auto-varredura' });
    expect(r).toMatchObject({ id: 'a1', level: 'read', denyEdits: true, allowEditsUnder: null });
    expect(r.allowBash[0]).toEqual({ program: 'git', sub: ['log', 'diff', 'status', 'show'] });
    expect(programs(r)).toContain('gh pr view');
    expect(programs(r)).not.toContain('gh issue create');
    expect(programs(r).some((p) => /push|merge/.test(p))).toBe(false);
  });
  it('worktree: edits only under the worktree, git add and commit', () => {
    const r = guardRules({ ...base, level: 'worktree' }, { worktreePath: '/r-auto-varredura' });
    expect(r).toMatchObject({ denyEdits: false, allowEditsUnder: '/r-auto-varredura' });
    expect(r.allowBash[0].sub).toEqual(['log', 'diff', 'status', 'show', 'add', 'commit']);
    expect(programs(r)).not.toContain('gh issue create');
  });
  it('normalizes the worktree path and fails closed on a relative one', () => {
    expect(guardRules({ ...base, level: 'worktree' }, { worktreePath: '/x/../y/' }).allowEditsUnder).toBe('/y');
    const r = guardRules({ ...base, level: 'worktree' }, { worktreePath: 'rel/wt' });
    expect(r.denyEdits).toBe(true);
    expect(r.allowEditsUnder).toBeNull();
  });
  it('worktree or project without a path fails closed', () => {
    for (const level of ['worktree', 'project']) {
      const r = guardRules({ ...base, level }, {});
      expect(r.denyEdits).toBe(true);
      expect(r.allowEditsUnder).toBeNull();
    }
  });
  it('project: the gh writes the spec allows, never a merge', () => {
    const r = guardRules({ ...base, level: 'project' }, { worktreePath: '/wt' });
    expect(r).toMatchObject({ denyEdits: false, allowEditsUnder: '/wt' });
    for (const c of ['gh issue create', 'gh issue comment', 'gh pr comment', 'gh pr create', 'gh pr review']) expect(programs(r)).toContain(c);
    expect(programs(r).some((p) => /merge|update-branch|sync/.test(p))).toBe(false);
  });
  it('the test and lint commands become exact entries (no extra words); unsafe ones are dropped', () => {
    const r = guardRules({ ...base, level: 'read' }, { testCmd: 'npm test', lintCmd: 'npx eslint .' });
    expect(r.allowBash).toContainEqual({ program: 'npm', argsPrefix: ['test'], extra: 'none' });
    expect(r.allowBash).toContainEqual({ program: 'npx', argsPrefix: ['eslint', '.'], extra: 'none' });
    expect(guardRules({ ...base, level: 'read' }, { testCmd: 'npm test; git push' }).allowBash.some((e) => e.program === 'npm')).toBe(false);
  });
});

describe('runEnv', () => {
  const base = { id: 'a1', level: 'worktree' };
  const configOf = (env) =>
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]);

  it('drops the push credentials and marks the run, at every level', () => {
    for (const level of ['read', 'worktree', 'project']) {
      const env = runEnv({ ...base, level }, {
        PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s', GH_TOKEN: 't', GITHUB_TOKEN: 't', GH_ENTERPRISE_TOKEN: 't',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y', GIT_CONFIG_KEY_42: 'stale', GIT_CONFIG_PARAMETERS: "'a'='b'",
      });
      expect(env).toMatchObject({
        PATH: '/bin', HOME: '/h', VIZOR_INTERNAL: '1', VIZOR_AUTOMATION: 'a1', VIZOR_GUARD_ASK_MS: '300000',
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false',
      });
      for (const name of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_42'])
        expect(env).not.toHaveProperty(name);
      const config = configOf(env);
      expect(config).toContainEqual(['credential.helper', '']);
      expect(config).toContainEqual(['push.default', 'nothing']);
      const rewritten = config.filter(([key]) => key === 'url.invalid://vizor-automation/.pushInsteadOf').map(([, value]) => value);
      for (const prefix of ['https://', 'http://', 'ssh://', 'git@', 'git://', 'file://', '/']) expect(rewritten).toContain(prefix);
      expect(config).not.toContainEqual(['x', 'y']);
    }
  });

  it('does not change the env it was given', () => {
    const given = { GH_TOKEN: 't' };
    runEnv(base, given);
    expect(given).toEqual({ GH_TOKEN: 't' });
  });

  it('real git: a push fails with the env applied, and works without it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzpush-'));
    try {
      const bare = path.join(dir, 'remote.git');
      const work = path.join(dir, 'work');
      const plain = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
      const git = (args, env = plain) => spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
      execFileSync('git', ['init', '-q', '--bare', bare], { env: plain });
      execFileSync('git', ['init', '-q', '-b', 'main', work], { env: plain });
      git(['remote', 'add', 'origin', bare]);
      git(['commit', '-q', '--allow-empty', '-m', 'one']);
      const env = runEnv(base, plain);
      for (const args of [['push'], ['push', 'origin', 'main'], ['push', bare, 'main'], ['push', `file://${bare}`, 'main']])
        expect(git(args, env).status, args.join(' ')).not.toBe(0);
      expect(git(['log', '--oneline'], env).status).toBe(0); // reads still work
      expect(execFileSync('git', ['--git-dir', bare, 'branch'], { env: plain, encoding: 'utf8' })).toBe('');
      expect(git(['push', 'origin', 'main']).status).toBe(0); // the repo itself is fine
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
