import { describe, it, expect } from 'vitest';
import { evaluate, parseGitAction, splitCommand } from '../src/hook/rule-guard.js';

// The spec's six example rules, compiled the way the compiler should.
const RULES = [
  {
    id: 'main',
    source: 'nunca dar push nem merge na main sem me perguntar',
    kind: 'ask',
    irreversible: true,
    explain: 'push ou merge na branch principal',
    match: [{ type: 'git', actions: ['push', 'merge', 'pr-merge'], target: 'default' }],
  },
  {
    id: 'drop',
    source: 'nunca de drop em nada de banco de dados',
    kind: 'forbid',
    irreversible: true,
    explain: 'DROP ou TRUNCATE em banco',
    match: [{ type: 'sql', statements: ['DROP', 'TRUNCATE'] }],
  },
  {
    id: 'prod',
    source: 'quando ver o termo PROD em algo avise/pergunte se pode mesmo',
    kind: 'ask',
    irreversible: false,
    explain: 'algo que menciona PROD',
    match: [{ type: 'keyword', words: ['prod'] }],
  },
  {
    id: 'owner',
    source: 'não commite nada em branch dos outros de forma automatica',
    kind: 'ask',
    irreversible: false,
    explain: 'commit ou push numa branch de outra pessoa',
    match: [{ type: 'git', actions: ['commit', 'push'], target: 'others' }],
  },
  { id: 'coauthor', source: 'não se autoreferencie no commit (co-autoria)', kind: 'agent', irreversible: false, explain: '', match: [] },
  { id: 'read', source: 'leia todas as regras antes de tudo', kind: 'agent', irreversible: false, explain: '', match: [] },
];

const onMain = { currentBranch: 'main', defaultBranch: 'main', ownBranch: true };
const onFeature = { currentBranch: 'feat/x', defaultBranch: 'main', ownBranch: true };
const bash = (command) => ({ tool: 'Bash', input: { command } });
const hit = (call, git = onFeature, rules = RULES) => evaluate({ rules, call, git })?.rule.id ?? null;

describe('splitCommand', () => {
  it('splits chains and unwraps sh -c, sudo, env and VAR= prefixes', () => {
    expect(splitCommand('cd /r && FOO=1 git push; sudo env A=b ls | wc -l')).toEqual([
      'cd /r',
      'git push',
      'ls',
      'wc -l',
    ]);
    expect(splitCommand(`bash -c "git push -f origin main"`)).toEqual(['git push -f origin main']);
  });
});

describe('parseGitAction', () => {
  it('reads the push destination from the refspec', () => {
    expect(parseGitAction('git push origin HEAD:main')).toMatchObject({ action: 'push', target: 'main', force: false });
    expect(parseGitAction('git push -f origin main')).toMatchObject({ action: 'push', target: 'main', force: true });
    expect(parseGitAction('git push')).toMatchObject({ action: 'push', target: null, force: false });
    expect(parseGitAction('git push -u origin feat/x')).toMatchObject({ action: 'push', target: 'feat/x', force: false });
  });

  it('knows gh pr merge, reset --hard and branch -D', () => {
    expect(parseGitAction('gh pr merge 141 --merge')).toMatchObject({ action: 'pr-merge', target: null, force: false });
    expect(parseGitAction('git reset --hard HEAD~1')?.action).toBe('reset-hard');
    expect(parseGitAction('git branch -D velha')?.action).toBe('branch-delete');
    expect(parseGitAction('git log maintenance')).toBeNull();
  });
});

describe('evaluate', () => {
  it('asks before a push to main, and calls it irreversible', () => {
    const result = evaluate({ rules: RULES, call: bash('git push origin main'), git: onFeature });
    expect(result.rule.id).toBe('main');
    expect(result.irreversible).toBe(true);
  });

  it('sees through chains, env prefixes and sh -c', () => {
    expect(hit(bash('cd /r && FOO=1 git push origin HEAD:main'))).toBe('main');
    expect(hit(bash('bash -c "git push -f origin main"'))).toBe('main');
  });

  it('a bare push targets the current branch', () => {
    expect(hit(bash('git push origin feat/x'), onMain)).toBeNull();
    expect(hit(bash('git push'), onMain)).toBe('main');
    expect(hit(bash('git push'), onFeature)).toBeNull();
  });

  it('gh pr merge counts as a merge into the default branch', () => {
    expect(hit(bash('gh pr merge 141 --merge'))).toBe('main');
  });

  it('git merge only counts when standing on the default branch', () => {
    expect(hit(bash('git merge feat/x'), onMain)).toBe('main');
    expect(hit(bash('git merge feat/x'), { ...onFeature, currentBranch: 'feat/y' })).toBeNull();
  });

  it('forbids DROP in commands, .sql files and database tools, not in a .js comment', () => {
    expect(hit(bash('psql -c "DROP TABLE users"'))).toBe('drop');
    expect(hit({ tool: 'Write', input: { file_path: 'db/001.sql', content: 'drop table x;' } })).toBe('drop');
    expect(hit({ tool: 'Write', input: { file_path: 'src/a.js', content: '// DROP' } })).toBeNull();
    expect(hit({ tool: 'mcp__supabase__execute_sql', input: { query: 'truncate t' } })).toBe('drop');
  });

  it('PROD is a whole word: product does not count', () => {
    expect(hit(bash('kubectl --context PROD apply'))).toBe('prod');
    expect(hit(bash('cat product.md'))).toBeNull();
    expect(hit({ tool: 'Edit', input: { file_path: 'config/prod.env', old_string: 'a', new_string: 'b' } })).toBe('prod');
  });

  it('a branch of someone else (or unknown) asks before a commit', () => {
    expect(hit(bash('git commit -m x'), { ...onFeature, ownBranch: false })).toBe('owner');
    expect(hit(bash('git commit -m x'), { ...onFeature, ownBranch: true })).toBeNull();
    expect(hit(bash('git commit -m x'), { ...onFeature, ownBranch: null })).toBe('owner');
  });

  it('without git context, a git rule on the default branch still matches', () => {
    expect(evaluate({ rules: RULES, call: bash('git push'), git: null })?.rule.id).toBe('main');
  });

  it('agent rules never match', () => {
    const agentOnly = RULES.filter((rule) => rule.kind === 'agent');
    expect(hit(bash('git commit -m "Co-Authored-By: x"'), onFeature, agentOnly)).toBeNull();
  });

  it('a forbid wins over an ask that also matches', () => {
    expect(hit(bash('psql prod -c "drop table x"'))).toBe('drop');
  });

  it('main inside a longer word is not the main branch', () => {
    expect(hit(bash('git log maintenance'))).toBeNull();
  });

  it('an invalid regex is skipped, never thrown', () => {
    const rules = [
      { id: 'bad', source: 'x', kind: 'forbid', irreversible: false, explain: '', match: [{ type: 'command', pattern: '(' }] },
      { id: 'rm', source: 'y', kind: 'forbid', irreversible: true, explain: '', match: [{ type: 'command', pattern: 'rm\\s+-rf' }] },
    ];
    expect(() => evaluate({ rules, call: bash('ls'), git: null })).not.toThrow();
    expect(hit(bash('rm -rf /tmp/x'), onFeature, rules)).toBe('rm');
  });

  it('a tool rule matches the tool name', () => {
    const rules = [{ id: 't', source: 'z', kind: 'ask', irreversible: false, explain: '', match: [{ type: 'tool', pattern: '^mcp__.*__deploy$' }] }];
    expect(hit({ tool: 'mcp__vercel__deploy', input: {} }, onFeature, rules)).toBe('t');
    expect(hit(bash('ls'), onFeature, rules)).toBeNull();
  });
});

describe('final review fixes', () => {
  it('redirections and a trailing & do not hide the push target (C1)', () => {
    for (const command of [
      'git push origin main 2>&1',
      'git push origin main 2>&1 | tail -5',
      'git push origin main > /tmp/log',
      'git push origin main &',
    ])
      expect(hit(bash(command)), command).toBe('main');
  });

  it('loops, conditionals, groups, wrappers and substitutions still count (I2)', () => {
    for (const command of [
      'for b in main; do git push origin $b; done',
      'if true; then git push origin main; fi',
      '{ git push origin main; }',
      '(git push origin main)',
      'sleep 1 & git push origin main',
      'timeout 60 git push origin main',
      'nice -n 5 git push origin main',
      'sudo -u me git push origin main',
      'echo $(git push origin main)',
      'echo `git push origin main`',
      'eval "git push origin main"',
      'git push origin main feature',
    ])
      expect(hit(bash(command)), command).toBe('main');
    expect(hit(bash('git push --all'))).toBe('main');
  });

  it('DROP only counts as a statement, and never in a commit message, a search or a chat tool (I3)', () => {
    for (const command of ['git commit -m "drop unused import"', 'cat drop.sql', 'grep -rn "DROP TABLE" migrations/'])
      expect(hit(bash(command)), command).toBeNull();
    expect(hit({ tool: 'mcp__slack__send_message', input: { text: 'we can drop table x later' } })).toBeNull();
    expect(hit(bash('psql -c "DROP TABLE users"'))).toBe('drop');
    expect(hit(bash('echo "drop database app" | psql'))).toBe('drop');
    expect(hit({ tool: 'mcp__postgres__query', input: { sql: 'truncate t' } })).toBe('drop');
  });

  it('an underscore is a word boundary for keywords, so DB_PROD counts', () => {
    expect(hit(bash('echo $DB_PROD'))).toBe('prod');
    expect(hit(bash('PROD_URL=x ./deploy.sh'))).toBe('prod');
    expect(hit(bash('cat product.md'))).toBeNull();
  });
});

describe('the repo a git command runs in (#165)', () => {
  // Own feature branch here; someone else's branch in ../outro.
  const asked = [];
  const byDir = (dir) => {
    asked.push(dir);
    if (dir === null) return null; // decide's answer for a directory it cannot resolve
    return dir === '../outro' || dir === '/abs/outro' ? { currentBranch: 'feat/dele', defaultBranch: 'main', ownBranch: false } : onFeature;
  };
  const at = (command) => {
    asked.length = 0;
    return evaluate({ rules: RULES, call: bash(command), git: byDir })?.rule.id ?? null;
  };

  it('a cd before the push judges it in the repo it lands in', () => {
    expect(at('git push')).toBeNull();
    expect(at('cd ../outro && git push')).toBe('owner');
    expect(at('cd /abs/outro; git commit -m x')).toBe('owner');
    expect(at('git -C ../outro push')).toBe('owner');
    expect(at('cd .. && git -C outro push')).toBe('owner');
  });

  it('a cd it cannot follow is unknown: the guard asks', () => {
    // unknown branch and owner: both the main and the owner rules hold
    expect(at('cd "$REPO" && git push')).not.toBeNull();
    expect(asked).toContain(null);
  });

  it('no git action, no git context', () => {
    expect(at('cd ../outro && ls')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('global options with a value do not hide the subcommand (#165)', () => {
    for (const command of [
      'git --git-dir .git push origin main',
      'git --git-dir=.git push origin main',
      'git --work-tree . push origin main',
      'git --work-tree=. push origin main',
      'git --namespace ns push origin main',
      'git --config-env=core.x=ENV push origin main',
      'git --super-prefix sub/ push origin main',
      'git -c a=b --git-dir .git --work-tree . push origin main',
    ]) {
      expect(parseGitAction(command), command).toMatchObject({ action: 'push', target: 'main' });
      expect(hit(bash(command)), command).toBe('main');
    }
  });

  it('--work-tree and --git-dir say where the command runs, like -C (#165)', () => {
    expect(parseGitAction('git --work-tree ../outro push')).toMatchObject({ dir: '../outro' });
    expect(parseGitAction('git --work-tree=../outro push')).toMatchObject({ dir: '../outro' });
    expect(parseGitAction('git --git-dir ../outro/.git push')).toMatchObject({ dir: '../outro' });
    expect(parseGitAction('git --git-dir=/srv/repo.git push')).toMatchObject({ dir: '/srv/repo.git' });
    expect(parseGitAction('git -C .. --work-tree outro push')).toMatchObject({ dir: '../outro' });
    expect(at('git --work-tree ../outro commit -m x')).toBe('owner');
    expect(at('git --git-dir=../outro/.git push')).toBe('owner');
  });

  it('parseGitAction keeps the -C directory', () => {
    expect(parseGitAction('git -C ../x push')).toMatchObject({ action: 'push', dir: '../x' });
    expect(parseGitAction('git push')).toMatchObject({ dir: '' });
    expect(parseGitAction('git -C "$X" push')).toMatchObject({ dir: null });
  });
});
