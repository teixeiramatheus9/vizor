import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, loadTaskRules, taskVerdict } from '../src/hook/rule-guard.js';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook', 'rule-guard.js');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A worktree with one locked contract test, the plan, a test the tests phase
// may write, a symlink and a hard link to the locked one.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vztask-')));
const root = path.join(scratch, 'repo');
const other = path.join(scratch, 'other');
const locked = path.join(root, 'test', 'a.test.js');
const second = path.join(root, 'test', 'b.test.js');
const planFile = path.join(root, '.vizor', 'plano-7.md');
const source = path.join(root, 'src', 'x.js');
const LOCKED_TEXT = 'it("a", () => {});\n';
for (const dir of ['test', '.vizor', 'src']) fs.mkdirSync(path.join(root, dir), { recursive: true });
fs.mkdirSync(other);
fs.writeFileSync(locked, LOCKED_TEXT);
fs.writeFileSync(second, 'it("b", () => {});\n');
fs.writeFileSync(planFile, '# Plano\n');
fs.writeFileSync(source, 'export const x = 1;\n');
fs.symlinkSync(locked, path.join(root, 'link.js'));
fs.linkSync(locked, path.join(other, 'hard.js'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const body = ({ phase = 'contract', hash = sha256(LOCKED_TEXT), lockedPath = locked } = {}) => ({
  version: 1,
  sessions: { s1: { phase, allowEdits: [second], planFile } },
  folders: { [root]: { locked: [{ path: lockedPath, sha256: hash }] } },
});
const load = (content, log) => loadTaskRules(() => (typeof content === 'string' ? content : JSON.stringify(content)), '/x/regras.json', log);
const bash = (command) => ({ tool: 'Bash', input: { command } });
const edit = (file, tool = 'Edit') => ({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } });
const verdict = (call, { session = 's1', cwd = root, rules = load(body()) } = {}) => taskVerdict({ rules, call, cwd, sessionId: session });

const CONTRACT = 'Tarefa do Vizor: aprove o contrato antes de mexer no código.';
const TESTS = 'Tarefa do Vizor: só os testes do contrato agora.';
const LOCKED = /^Tarefa do Vizor: test\/a\.test\.js é um teste travado do contrato/;
const UNREADABLE = /^Tarefa do Vizor: .*não consigo ler.*test\/a\.test\.js/;
const SHIP = 'Tarefa do Vizor: o teste do contrato mudou; destrave ou volte o arquivo (test/a.test.js).';

describe('loadTaskRules', () => {
  it('a missing file is no task mode, without a log', () => {
    const logged = [];
    const missing = () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    expect(loadTaskRules(missing, '/x', (line) => logged.push(line))).toBeNull();
    expect(logged).toEqual([]);
  });

  for (const [name, content] of [
    ['not json', '{not json'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ ...body(), version: 2 })],
    ['sessions not an object', JSON.stringify({ ...body(), sessions: [] })],
  ]) {
    it(`${name}: task mode is skipped and logged (interactive protection, not automation)`, () => {
      const logged = [];
      expect(load(content, (line) => logged.push(line))).toBeNull();
      expect(logged).toHaveLength(1);
    });
  }

  it('a locked path relative to the folder is read against it', () => {
    expect(verdict(edit(locked), { rules: load(body({ lockedPath: 'test/a.test.js' })), session: 'nobody' })).toMatch(LOCKED);
  });
});

describe('the phase gates hold the bound session', () => {
  it('contract: only the plan file may be edited', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(verdict(edit(source, tool))).toBe(CONTRACT);
    expect(verdict(edit(second))).toBe(CONTRACT);
    expect(verdict(edit(planFile))).toBeNull();
    expect(verdict(edit(planFile, 'Write'))).toBeNull();
  });

  it('tests: the plan and the allowed tests, nothing else', () => {
    const rules = load(body({ phase: 'tests' }));
    expect(verdict(edit(source), { rules })).toBe(TESTS);
    expect(verdict(edit(path.join(root, 'test', 'new.test.js')), { rules })).toBe(TESTS);
    expect(verdict(edit(second), { rules })).toBeNull();
    expect(verdict(edit(planFile), { rules })).toBeNull();
  });

  it('later phases do not gate edits', () => {
    for (const phase of ['steps', 'pr', 'quick']) expect(verdict(edit(source), { rules: load(body({ phase })) })).toBeNull();
  });

  it('a relative or ../ path cannot be checked: the gate denies it', () => {
    expect(verdict(edit('src/x.js'))).toBe(CONTRACT);
    expect(verdict(edit(`${root}/src/../src/x.js`))).toBe(CONTRACT);
  });

  it('Bash is not gated by the phase: the chat may run anything', () => {
    for (const command of ['npm install', 'node script.js', 'echo x > src/x.js', 'rm -rf src', 'git commit -am wip'])
      expect(verdict(bash(command))).toBeNull();
  });

  it('another session in the same folder passes the gates but not the locked files', () => {
    expect(verdict(edit(source), { session: 's2' })).toBeNull();
    expect(verdict(bash('echo x > src/x.js'), { session: 's2' })).toBeNull();
    expect(verdict(edit(locked), { session: 's2' })).toMatch(LOCKED);
    expect(verdict(bash('echo x > test/a.test.js'), { session: 's2' })).toMatch(LOCKED);
  });

  it('a session with no id or a prototype key is not bound', () => {
    expect(verdict(edit(source), { session: null })).toBeNull();
    expect(verdict(edit(source), { session: '__proto__' })).toBeNull();
  });
});

describe('the locked tests hold for the whole folder', () => {
  it('editing a locked test is denied in every phase, for every session', () => {
    for (const phase of ['contract', 'tests', 'steps', 'pr'])
      for (const session of ['s1', 's2']) expect(verdict(edit(locked), { rules: load(body({ phase })), session })).toMatch(LOCKED);
  });

  it('a symlink or a hard link to a locked test is the locked test', () => {
    expect(verdict(edit(path.join(root, 'link.js')), { session: 's2' })).toMatch(LOCKED);
    expect(verdict(edit(path.join(other, 'hard.js')), { session: 's2', cwd: other })).toMatch(LOCKED);
    expect(verdict(bash('echo x > link.js'), { session: 's2' })).toMatch(LOCKED);
    expect(verdict(bash(`sed -i s/a/b/ ${other}/hard.js`), { session: 's2' })).toMatch(LOCKED);
  });

  it('Bash writes to a locked test are denied', () => {
    const writes = [
      'echo x > test/a.test.js',
      'echo x >> test/a.test.js',
      'echo x >| test/a.test.js',
      `echo x > ${locked}`,
      'sed -i s/a/b/ test/a.test.js',
      'sed -i.bak -e s/a/b/ test/a.test.js',
      'echo x | tee test/a.test.js',
      'tee -a test/a.test.js',
      'cp src/x.js test/a.test.js',
      'cp -t test a.test.js',
      'mv test/a.test.js test/old.js',
      'mv src/x.js test/a.test.js',
      'rm test/a.test.js',
      'rm -rf test',
      'truncate -s0 test/a.test.js',
      'git checkout -- test/a.test.js',
      'git checkout HEAD~1 test/a.test.js',
      'git restore test/a.test.js',
      'git restore .',
      'git -C test checkout a.test.js',
      'cd test && rm a.test.js',
      'cd test && echo x > a.test.js',
      'npm test; rm test/a.test.js',
      'sudo rm test/a.test.js',
      'ln -f src/x.js test/a.test.js',
      'dd if=src/x.js of=test/a.test.js',
    ];
    for (const command of writes) expect(verdict(bash(command), { session: 's2' }) ?? '', command).toMatch(LOCKED);
  });

  it('a Bash line the guard cannot read that names a locked test is denied', () => {
    for (const command of ['cat $(echo test/a.test.js)', 'perl -pi -e "s/a/$x/" test/a.test.js', 'echo x>test/a.test.js', 'cp x "$D"/a.test.js'])
      expect(verdict(bash(command), { session: 's2' }), command).toMatch(UNREADABLE);
  });

  it('reading or running a locked test is fine', () => {
    for (const command of [
      'cat test/a.test.js',
      'npx vitest run test/a.test.js',
      'npx vitest run test/a.test.js > /tmp/out.txt 2>&1',
      'cp test/a.test.js /tmp/copy.js',
      'cp src/x.js test',
      'git diff test/a.test.js',
      'git checkout main',
      'grep -n it test/a.test.js | head',
      'echo x > test/b.test.js',
      'rm -rf src',
      'cat $(ls src)',
    ])
      expect(verdict(bash(command), { session: 's2' }), command).toBeNull();
  });

  it('a session outside every folder may write its own files', () => {
    expect(verdict(bash('cat $(echo a.test.js)'), { session: 's9', cwd: other })).toBeNull();
    expect(verdict(bash(`cat $(echo ${locked})`), { session: 's9', cwd: other })).toMatch(UNREADABLE);
    expect(verdict(bash('echo x > a.test.js'), { session: 's9', cwd: other })).toBeNull();
    expect(verdict(edit(path.join(other, 'a.test.js')), { session: 's9', cwd: other })).toBeNull();
  });
});

describe('push and PR while a locked test differs', () => {
  const changed = () => load(body({ hash: sha256('the approved text') }));
  const SHIPS = ['git push', 'git -C . push', 'git push origin main', 'gh pr create --fill', 'gh -R me/repo pr create', 'npm test && git push', 'bash -c "git push"'];

  it('git push / gh pr create are denied when a hash changed', () => {
    for (const command of SHIPS) expect(verdict(bash(command), { rules: changed(), session: 's2' }), command).toBe(SHIP);
  });

  it('a push from a subfolder or with -C into the folder counts', () => {
    expect(verdict(bash('git push'), { rules: changed(), cwd: path.join(root, 'src') })).toBe(SHIP);
    expect(verdict(bash(`git -C ${root} push`), { rules: changed(), cwd: other })).toBe(SHIP);
  });

  it('the same commands pass when every hash matches', () => {
    for (const command of SHIPS) expect(verdict(bash(command), { session: 's2' }), command).toBeNull();
  });

  it('a missing locked file counts as changed', () => {
    const gone = path.join(root, 'test', 'gone.test.js');
    expect(verdict(bash('git push'), { rules: load(body({ lockedPath: gone, hash: sha256('x') })) })).toBe(
      'Tarefa do Vizor: o teste do contrato mudou; destrave ou volte o arquivo (test/gone.test.js).',
    );
  });

  it('outside the folder, other commands and other folders are not held', () => {
    expect(verdict(bash('git push'), { rules: changed(), cwd: other })).toBeNull();
    expect(verdict(bash('git status'), { rules: changed() })).toBeNull();
    expect(verdict(bash('gh pr view 3'), { rules: changed() })).toBeNull();
  });
});

describe('a PR opened from another folder or through gh api', () => {
  const changed = () => load(body({ hash: sha256('the approved text') }));
  const API_CREATES = [
    'gh api repos/o/r/pulls -f title=x -f head=b -f base=main',
    'gh api /repos/o/r/pulls -F title=x',
    'gh api repos/{owner}/{repo}/pulls --field title=x',
    'gh api repos/o/r/pulls --raw-field title=x',
    'gh api repos/o/r/pulls --input pr.json',
    'gh api -X POST repos/o/r/pulls',
    'gh api --method POST repos/o/r/pulls',
    'gh api --method=post repos/o/r/pulls',
    'gh api repos/o/r/pulls -ftitle=x',
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { url } } }'",
  ];

  it('cd into the folder, then gh pr create, is held when a lock changed and passes when it did not', () => {
    for (const command of [`cd ${root} && gh pr create --fill`, `pushd ${root}; gh pr create`, `cd ${root}/src && gh pr new`]) {
      expect(verdict(bash(command), { rules: changed(), cwd: other }), command).toBe(SHIP);
      expect(verdict(bash(command), { cwd: other }), command).toBeNull();
    }
  });

  it('a plain gh pr create from the folder is still held when a lock changed', () => {
    expect(verdict(bash('gh pr create --fill'), { rules: changed() })).toBe(SHIP);
    expect(verdict(bash('gh pr create --fill'), { rules: changed(), cwd: other })).toBeNull();
  });

  it('gh api creating a pull request ships, also after a cd', () => {
    for (const command of API_CREATES) {
      expect(verdict(bash(command), { rules: changed() }), command).toBe(SHIP);
      expect(verdict(bash(command)), command).toBeNull();
    }
    expect(verdict(bash(`cd ${root} && ${API_CREATES[0]}`), { rules: changed(), cwd: other })).toBe(SHIP);
  });

  it('reading pull requests through gh api is fine', () => {
    for (const command of ['gh api repos/o/r/pulls', 'gh api repos/o/r/pulls -X GET -f state=open', 'gh api repos/o/r/pulls/3', 'gh api repos/o/r/pulls --jq ".[].title"', 'gh api graphql -f query="{ viewer { login } }"']) {
      expect(verdict(bash(command), { rules: changed() }), command).toBeNull();
    }
  });
});

describe('decide', () => {
  const event = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command }, ...extra });

  it('the task verdict comes before the user rules and is told to the Vizor', async () => {
    const notes = [];
    const out = await decide({
      event: event('echo x > test/a.test.js'),
      rules: null,
      task: load(body()),
      notify: (note) => notes.push(note),
      ask: async () => 'liberar',
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(LOCKED);
    expect(notes).toEqual([expect.objectContaining({ type: 'guard-event', outcome: 'barrado', sessionId: 's1' })]);
  });

  it('without task rules nothing changes', async () => {
    expect(await decide({ event: event('echo x > test/a.test.js'), rules: null, task: null, ask: async () => 'liberar' })).toBeNull();
  });
});

describe('script', () => {
  let home;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vztask-home-')));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const writeTask = (content) => {
    const dir = path.join(home, '.config', 'vizor', 'tarefas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'regras.json'), content);
  };
  function guard(event, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], {
        env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), ...env },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, ...event }));
    });
  }
  const reasonOf = (result) => JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;

  it('holds the gates and the locked tests with only the task file installed', async () => {
    writeTask(JSON.stringify(body()));
    const gated = await guard({ tool_name: 'Edit', tool_input: { file_path: source } });
    expect(gated.code).toBe(0);
    expect(reasonOf(gated)).toBe(CONTRACT);
    expect(reasonOf(await guard({ tool_name: 'Bash', tool_input: { command: 'echo x > test/a.test.js' } }))).toMatch(LOCKED);
    expect(await guard({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toEqual({ code: 0, stdout: '' });
  });

  it('a corrupt file skips the task mode and logs it', async () => {
    writeTask('{not json');
    expect(await guard({ tool_name: 'Edit', tool_input: { file_path: locked } })).toEqual({ code: 0, stdout: '' });
    expect(fs.readFileSync(path.join(home, '.config', 'vizor', 'log'), 'utf8')).toMatch(/tarefas\/regras\.json/);
  });

  it('an automação is held by its own rules, not the task mode', async () => {
    writeTask(JSON.stringify(body()));
    const result = await guard({ tool_name: 'Edit', tool_input: { file_path: source } }, { VIZOR_AUTOMATION: 'auto-1' });
    expect(result.code).toBe(0);
    expect(reasonOf(result)).toMatch(/^Automação do Vizor/);
  });

  it('without the file nothing is printed', async () => {
    expect(await guard({ tool_name: 'Edit', tool_input: { file_path: locked } })).toEqual({ code: 0, stdout: '' });
  });
});
