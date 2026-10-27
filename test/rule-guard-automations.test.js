import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MISSING_AUTOMATION_RULES, automationVerdict, decide, loadAutomationRules } from '../src/hook/rule-guard.js';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook', 'rule-guard.js');
const NEVER = [
  'git push', 'git merge', '--force', 'gh pr merge',
  'git branch -D', 'git branch -d', 'git reset --hard', 'git clean -f', 'git push --force-with-lease',
];

// Built at load time: the test names below spell these paths out.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzauto-'))); // realpath'd, like the guard sees it
const root = path.join(scratch, 'repo-auto-x'); // the automação's worktree
const outside = path.join(scratch, 'outside'); // a directory next to it
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'a.txt'), 'a');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(root, 'dangling'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const rulesFor = (level) => ({
  id: 'auto-1',
  level,
  denyAlways: [...NEVER],
  denyGhWrite: level !== 'project',
  denyEdits: level === 'read',
  allowEditsUnder: level === 'worktree' ? root : null,
});
const bash = (command) => ({ tool: 'Bash', input: { command } });
const edit = (file, tool = 'Edit') => ({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } });
const verdict = (call, level = 'worktree', cwd = root) => automationVerdict({ rules: rulesFor(level), call, cwd });
// bash -c "bash -c \"…\"", n deep.
const nest = (command, n) => (n === 0 ? command : `bash -c ${JSON.stringify(nest(command, n - 1))}`);
const denied = (command, level, cwd) => verdict(bash(command), level, cwd) !== null;

describe('automação: never, at any level', () => {
  const bypasses = [
    'git push',
    'git push origin main',
    'bash -c "git push"',
    "sh -lc 'git push'",
    'env git push',
    'env -S "git push"',
    'sudo -u x git push',
    'timeout 5 git push',
    'nohup git push &',
    'xargs git push',
    'git -C . push',
    'git -c x=y push origin main',
    'git --no-pager --git-dir=.git --work-tree=. push',
    '/usr/bin/git push',
    'true && git push',
    'ls; git push',
    'echo $(git push)',
    'echo `git push`',
    'cat <(git push)',
    'eval git push',
    "echo 'git push' | sh",
    "find . -exec git push \\;",
    "git submodule foreach 'git push'",
    'watch git push',
    'git send-pack origin main',
    'git push --force-with-lease',
    'git push origin +main',
    'git merge feat/x',
    'git pull',
    'gh pr merge 3',
    'gh pr merge --auto 3',
    'git branch -D x',
    'git branch -d x',
    'git branch --delete x',
    'git reset --hard HEAD~1',
    'git clean -f',
    'git clean -xdf',
    'git clean -fd',
    'git clean --force',
    'npm install --force',
    'gh api -X PUT repos/o/r/pulls/1/merge',
    "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
    'gh alias set m "pr merge"',
    'git -c alias.p=push p',
    'git config core.hooksPath hooks',
    nest('git push', 3),
  ];
  for (const command of bypasses) {
    it(`denies: ${command}`, () => {
      for (const level of ['read', 'worktree', 'project']) expect(denied(command, level), level).toBe(true);
    });
  }

  const fine = [
    'git status',
    'git log --merges --oneline',
    'git diff HEAD~1',
    'git commit -m "never git push here"',
    'git add .',
    'git clean -n',
    'git branch',
    'git config user.email',
    'npm test',
    'gh pr view 3',
    'grep -rn "git push" src',
  ];
  for (const command of fine) {
    it(`lets through at project level: ${command}`, () => {
      expect(verdict(bash(command), 'project')).toBeNull();
    });
  }

  it('a line nested too deep to read is denied, not waved through', () => {
    expect(denied(nest('git status', 12), 'project')).toBe(true);
  });

  it('says which level and what, in pt-BR, and not to dodge it', () => {
    const reason = verdict(bash('true && git push'), 'worktree');
    expect(reason).toMatch(/^Automação do Vizor \(nível [^)]+\): .+\. Não tente contornar\.$/);
    expect(reason).toContain('git push');
  });
});

describe('automação: gh that writes (levels 1 and 2)', () => {
  const writes = [
    'gh issue create -t x -b y',
    'gh issue comment 1 -b y',
    'gh issue close 1',
    'gh issue reopen 1',
    'gh pr create -t x',
    'gh pr comment 1 -b y',
    'gh pr review 1 --approve',
    'gh pr ready 1',
    'gh pr edit 1 -t x',
    'gh -R o/r issue create -t x',
    'gh release create v1',
    'gh repo delete o/r',
    'gh label create x',
    'gh api -X DELETE repos/x/y',
    'gh api -XDELETE repos/x/y',
    'gh api --method=PATCH repos/x/y',
    'gh api repos/x/y/issues -f title=t',
    'gh api repos/x/y/issues --input body.json',
    "gh api graphql -f query='mutation { addComment(input:{}) { clientMutationId } }'",
    'env gh issue create -t x',
  ];
  for (const command of writes) {
    it(`denies on worktree and read: ${command}`, () => {
      expect(denied(command, 'worktree')).toBe(true);
      expect(denied(command, 'read')).toBe(true);
    });
  }
  it('the project level may write with gh', () => {
    for (const command of ['gh issue create -t x', 'gh pr comment 1 -b y', 'gh api repos/x/y/issues -f title=t'])
      expect(verdict(bash(command), 'project')).toBeNull();
  });
  it('reading with gh is fine everywhere', () => {
    for (const command of ['gh pr view 1', 'gh issue list', 'gh api repos/x/y', 'gh api -X GET search/issues -f q=x', "gh api graphql -f query='query { viewer { login } }'"])
      expect(verdict(bash(command), 'worktree')).toBeNull();
  });
});

describe('automação: edit tools', () => {
  it('level 1 denies every edit tool', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(verdict(edit(path.join(root, 'a.txt'), tool), 'read')).toContain('Automação do Vizor');
  });

  it('level 2 edits inside the worktree only', () => {
    expect(verdict(edit(path.join(root, 'a.txt')))).toBeNull();
    expect(verdict(edit(path.join(root, 'sub', 'new', 'deep.txt'), 'Write'))).toBeNull();
    expect(verdict(edit(path.join(outside, 'a.txt')))).not.toBeNull();
    expect(verdict(edit(path.join(root, '..', 'outside', 'a.txt')))).not.toBeNull();
    expect(verdict(edit(`${root}-evil/a.txt`))).not.toBeNull(); // a prefix is not a parent
    expect(verdict(edit('relative.txt'), 'worktree', null)).not.toBeNull();
  });

  it('level 2 follows symlinks out of the worktree', () => {
    expect(verdict(edit(path.join(root, 'escape', 'a.txt')))).not.toBeNull();
    expect(verdict(edit(path.join(root, 'escape', 'new', 'b.txt'), 'Write'))).not.toBeNull();
    expect(verdict(edit(path.join(root, 'dangling'), 'Write'))).not.toBeNull();
  });

  it('never the Claude Code or Vizor config, nor git internals, at any level', () => {
    const home = os.homedir();
    for (const file of [
      path.join(home, '.claude', 'settings.json'),
      path.join(home, '.config', 'vizor', 'automacoes', 'regras.json'),
      path.join(root, '.claude', 'settings.json'),
      path.join(root, '.git', 'hooks', 'pre-commit'),
    ])
      for (const level of ['worktree', 'project']) expect(verdict(edit(file), level), `${level} ${file}`).not.toBeNull();
  });

  it('a symlink into ~/.claude is still ~/.claude', () => {
    const link = path.join(root, 'claude-link');
    fs.symlinkSync(path.join(os.homedir(), '.claude'), link);
    try {
      expect(verdict(edit(path.join(link, 'settings.json')), 'project', root)).not.toBeNull();
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('the project level edits anywhere else', () => {
    expect(verdict(edit(path.join(outside, 'a.txt')), 'project')).toBeNull();
  });
});

describe('automação: Bash writes outside the worktree (level 2, best effort)', () => {
  const out = (name) => path.join(outside, name);
  const escapes = [
    `cd ${outside} && echo > a`,
    'cd .. && touch a',
    'cd ../.. && rm -rf x',
    'cd && echo x > a',
    `echo hi > ${out('a')}`,
    `echo hi>${out('a')}`,
    `echo hi >> ${out('a')}`,
    `echo hi &> ${out('a')}`,
    `echo hi | tee ${out('a')}`,
    `cp a.txt ${outside}/`,
    `mv a.txt ${out('a')}`,
    `mv ${out('a')} here.txt`,
    `rm -rf ${outside}`,
    `sed -i s/a/b/ ${out('f')}`,
    `touch ${out('t')}`,
    `mkdir -p ${out('d')}`,
    `chmod 600 ${out('f')}`,
    `ln -s a.txt ${out('l')}`,
    `git -C ${outside} commit -m x`,
    `git -C ${outside} add .`,
    'echo hi > escape/a',
    'echo hi > ../outside/a',
    `bash -c "echo hi > ${out('a')}"`,
    'echo hi > "$OUT"',
  ];
  for (const command of escapes) {
    it(`denies: ${command}`, () => {
      expect(denied(command, 'worktree')).toBe(true);
    });
  }

  const inside = [
    'echo hi > a',
    'echo hi > sub/a',
    'npm test 2>/dev/null',
    'npm test > /dev/null 2>&1',
    'echo hi >&2',
    `cd ${outside} && ls`,
    'cp /etc/hosts ./h',
    "sed -i '/x/d' a.txt",
    'cd sub && touch a',
    `cd ${root}/sub && touch a`,
    'git add a.txt && git commit -m x',
    `git -C ${outside} log`,
  ];
  for (const command of inside) {
    it(`lets through: ${command}`, () => {
      expect(verdict(bash(command), 'worktree')).toBeNull();
    });
  }

  it('a session whose cwd already left the worktree cannot write relative paths', () => {
    expect(denied('echo hi > a', 'worktree', outside)).toBe(true);
  });

  it('level 1 writes nothing with Bash either', () => {
    for (const command of ['echo hi > a', 'touch a', 'git commit -m x', 'git add .']) expect(denied(command, 'read')).toBe(true);
    for (const command of ['git status', 'npm test > /dev/null']) expect(verdict(bash(command), 'read')).toBeNull();
  });

  it('no level writes the Claude Code or Vizor config through Bash', () => {
    expect(denied('echo x > ~/.claude/settings.json', 'project')).toBe(true);
    expect(denied('cd ~/.config/vizor && echo {} > automacoes/regras.json', 'project')).toBe(true);
    expect(denied('cp evil.json $HOME/.claude/settings.json', 'project')).toBe(true);
    expect(verdict(bash(`echo hi > ${out('a')}`), 'project')).toBeNull();
  });
});

describe('automação without its rules: read only (fail closed)', () => {
  const MESSAGE = 'Automação do Vizor: não achei as regras desta automação; só leitura até o Vizor gravar as regras.';
  const check = (call) => automationVerdict({ rules: MISSING_AUTOMATION_RULES, call, cwd: root });
  const reads = ['git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', 'git -C sub status', 'ls -la', 'cat a.txt', 'grep -rn x .', 'rg x', 'head -5 a.txt', 'tail a.txt', 'wc -l a.txt', 'pwd', 'echo hi', 'cat a.txt | grep a | wc -l', 'cd sub && ls', 'git status 2>/dev/null'];
  for (const command of reads) it(`lets read: ${command}`, () => expect(check(bash(command))).toBeNull());
  const writes = ['echo hi > a', 'git diff --output=x', 'git commit -m x', 'git push', 'gh pr view 1', 'gh issue create -t x', 'npm test', 'touch a', 'rm a.txt', 'bash -c "ls"', 'ls $(touch a)', 'cat a.txt | tee b', 'git -c x=y status', 'sed -n 1p a.txt'];
  for (const command of writes) it(`denies: ${command}`, () => expect(check(bash(command))).toBe(MESSAGE));
  it('denies every edit tool', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(check(edit(path.join(root, 'a.txt'), tool))).toBe(MESSAGE);
  });
  it('other tools (Read, Grep) pass', () => {
    expect(check({ tool: 'Read', input: { file_path: path.join(root, 'a.txt') } })).toBeNull();
  });
});

describe('loadAutomationRules', () => {
  const file = '/c/automacoes/regras.json';
  const read = (content) => (name) => {
    if (name !== file || content === undefined) throw new Error('ENOENT');
    return content;
  };
  const good = JSON.stringify({ version: 1, automations: { 'auto-1': rulesFor('worktree') } });

  it('reads the entry of this automação', () => {
    expect(loadAutomationRules(read(good), file, 'auto-1')).toEqual(rulesFor('worktree'));
  });
  it('no id, no file, a corrupt file or an unknown id: no rules', () => {
    expect(loadAutomationRules(read(good), file, '')).toBeNull();
    expect(loadAutomationRules(read(undefined), file, 'auto-1')).toBeNull();
    expect(loadAutomationRules(read('{oops'), file, 'auto-1')).toBeNull();
    expect(loadAutomationRules(read('null'), file, 'auto-1')).toBeNull();
    expect(loadAutomationRules(read(good), file, 'other')).toBeNull();
    expect(loadAutomationRules(read(good), file, '__proto__')).toBeNull();
  });
  it('a damaged entry fails closed: no edits, no gh writes, no relative root', () => {
    const damaged = JSON.stringify({ version: 1, automations: { a: { level: 'worktree', allowEditsUnder: 'rel/dir' } } });
    expect(loadAutomationRules(read(damaged), file, 'a')).toMatchObject({ denyGhWrite: true, denyEdits: true, allowEditsUnder: null });
  });
});

describe('decide with an automação', () => {
  const DEV_ASK = { id: 'prod', source: 'quando ver PROD pergunte', kind: 'ask', irreversible: false, explain: '', match: [{ type: 'keyword', words: ['prod'] }] };
  const event = (command) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command } });
  const base = { repoRoot: null, gitContext: () => null, headless: true };

  it('denies before the dev rules, and tells the Vizor which automação it was', async () => {
    const notes = [];
    let asked = false;
    const output = await decide({
      ...base,
      event: event('echo prod && git push'),
      rules: { version: 1, global: [DEV_ASK], repos: {} },
      automation: rulesFor('project'),
      automationId: 'auto-1',
      ask: async () => ((asked = true), 'liberar'),
      notify: (note) => notes.push(note),
    });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/^Automação do Vizor \(nível/);
    expect(asked).toBe(false);
    expect(notes).toEqual([expect.objectContaining({ type: 'guard-event', outcome: 'barrado', automationId: 'auto-1', sessionId: 's1' })]);
  });

  it('works without dev rules at all', async () => {
    const output = await decide({ ...base, event: event('git push'), rules: null, automation: rulesFor('read'), automationId: 'auto-1', ask: async () => 'offline' });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await decide({ ...base, event: event('git status'), rules: null, automation: rulesFor('read'), automationId: 'auto-1', ask: async () => 'offline' })).toBeNull();
  });

  it("the dev rules' questions carry the automação id", async () => {
    let request;
    await decide({
      ...base,
      event: event('echo prod'),
      rules: { version: 1, global: [DEV_ASK], repos: {} },
      automation: rulesFor('project'),
      automationId: 'auto-1',
      ask: async (sent) => ((request = sent), 'liberar'),
    });
    expect(request).toMatchObject({ type: 'guard-ask', automationId: 'auto-1', ruleId: 'prod' });
  });

  it('a chat that is not an automação sends no automationId', async () => {
    let request;
    await decide({ ...base, event: event('echo prod'), rules: { version: 1, global: [DEV_ASK], repos: {} }, ask: async (sent) => ((request = sent), 'liberar') });
    expect(request).not.toHaveProperty('automationId');
  });
});

describe('rule-guard script with VIZOR_AUTOMATION', () => {
  let home;
  const DROP = { id: 'drop', source: 'nunca drop', kind: 'forbid', irreversible: true, explain: '', match: [{ type: 'sql', statements: ['DROP'] }] };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzguard-auto-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const writeAutomations = (content) => {
    const dir = path.join(home, '.config', 'vizor', 'automacoes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'regras.json'), content);
  };
  const writeDevRules = () => {
    const dir = path.join(home, '.config', 'vizor', 'regras');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compiladas.json'), JSON.stringify({ version: 1, global: [DROP], repos: {} }));
  };
  function guard(command, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], {
        env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', ...env },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: home, tool_name: 'Bash', tool_input: { command } }));
    });
  }
  const rules = JSON.stringify({ version: 1, automations: { 'auto-1': rulesFor('read') } });

  it('denies git push inside bash -c, even with no dev rules installed', async () => {
    writeAutomations(rules);
    const result = await guard('bash -c "git push"', { VIZOR_AUTOMATION: 'auto-1' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^Automação do Vizor/);
  });

  it('without the env nothing changes', async () => {
    writeAutomations(rules);
    expect(await guard('git push')).toEqual({ code: 0, stdout: '' });
    writeDevRules();
    expect(await guard('git push')).toEqual({ code: 0, stdout: '' });
  });

  const reasonOf = (result) => JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  const MISSING = /^Automação do Vizor: não achei as regras desta automação; só leitura/;
  for (const [name, setup] of [
    ['a missing file', () => {}],
    ['a corrupt file', () => writeAutomations('{not json')],
    ['an unknown id', () => writeAutomations(JSON.stringify({ version: 1, automations: { other: rulesFor('project') } }))],
  ]) {
    it(`${name} fails closed: reads pass, writes are denied, exit 0`, async () => {
      setup();
      expect(await guard('git status', { VIZOR_AUTOMATION: 'auto-1' })).toEqual({ code: 0, stdout: '' });
      for (const command of ['git push', 'echo x > a', 'npm test']) {
        const result = await guard(command, { VIZOR_AUTOMATION: 'auto-1' });
        expect(result.code).toBe(0);
        expect(reasonOf(result)).toMatch(MISSING);
      }
    });
  }

  it('without its rules the dev rules still apply to what reads pass', async () => {
    writeDevRules();
    const result = await guard('echo "drop table x"', { VIZOR_AUTOMATION: 'auto-1' });
    expect(result.code).toBe(0);
    expect(reasonOf(result)).toContain('Barrado pela regra do usuário');
  });
});
