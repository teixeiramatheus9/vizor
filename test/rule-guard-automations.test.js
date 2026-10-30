import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MISSING_AUTOMATION_RULES, automationVerdict, decide, loadAutomationRules } from '../src/hook/rule-guard.js';
import { guardRules } from '../src/main/automations/permissions.js';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook', 'rule-guard.js');
const LEVELS = ['read', 'worktree', 'project'];
const MISSING = 'Automação do Vizor: não achei as regras desta automação; só leitura até o Vizor gravar as regras.';

// Built at load time: the test names below spell these paths out. A fake
// home, so ~/.claude is ours to link to.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vzauto-')));
const home = path.join(scratch, 'home');
const root = path.join(home, 'repo-auto-x'); // the automação's worktree
const outside = path.join(home, 'outside');
const claude = path.join(home, '.claude');
fs.mkdirSync(claude, { recursive: true });
fs.writeFileSync(path.join(claude, 'settings.json'), '{}');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'a.txt'), 'a');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(claude, path.join(root, 'cl'));
fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(root, 'dangling'));
fs.linkSync(path.join(claude, 'settings.json'), path.join(root, 'hl'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const rulesFor = (level) => guardRules({ id: 'auto-1', level }, { worktreePath: root, testCmd: 'npm test', lintCmd: 'npx eslint .' });
const bash = (command) => ({ tool: 'Bash', input: { command } });
const edit = (file, tool = 'Edit') => ({ tool, input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } });
const verdict = (call, level = 'worktree') => automationVerdict({ rules: rulesFor(level), call, cwd: root, home });
const deniedEverywhere = (call) => LEVELS.every((level) => verdict(call, level) !== null);

// Every probe of the adversarial review: each must be denied at every level.
const PUSH_PROBES = [
  'git push', 'git push origin main', "g''it push", '"git" push', '\\git push', 'command git push', 'exec git push',
  'gi\\\nt push', 'git\\\n push', "$'git' push", "git $'push'", 'IFS=,; x=git,push; $x', 'G=git; $G push', 'eval "git push"',
  'xargs git push', 'echo push | xargs git', 'echo push | xargs -I{} git {}', 'find . -exec git push \;', 'bash <<EOF\ngit push\nEOF',
  "bash <<< 'git push'", 'sh < x.sh', 'git -c alias.p=push p', 'git --exec-path=/tmp push', 'GIT_DIR=.git git push',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p', "GIT_CONFIG_PARAMETERS=\"'alias.p'='push'\" git p",
  'bash -c -- "git push"', 'bash -c "git push"', "sh -lc 'git push'", 'env git push', 'git {push,}', '{git,push}', '/usr/bin/g?t push',
  '/usr/*/git push', '$(echo git) push', '`echo git` push', 'echo $(git push)', 'cat <(git push)', 'git pu"sh"', 'git ${X:-push}',
  'ssh localhost "git push"', 'f(){ git push; }; f', 'sudo -E git push', 'git push&>/dev/null', 'git status&>/dev/null',
  'true && git push', 'git status; git push', 'git status | git push', 'git -C . push', 'git -C . status', 'git -c x=y status',
  'git merge x', 'git pull', 'git push --force-with-lease', 'git reset --hard HEAD', 'git clean -xdf', 'git branch -D x',
  'git branch -f main HEAD', 'git update-ref refs/heads/main HEAD', 'git stash', 'git stash -u', 'git status # x', 'git status &',
  'git log --output=/tmp/x', 'git diff --output /tmp/x', 'git diff --ext-diff', 'rg --pre ./evil x', 'rg --pre=./evil x',
  'npm test --script-shell=/tmp/evil', 'npm install', 'npm run build', 'npx eslint . ; git push', '/usr/bin/git status',
  'gh pr merge 3', 'gh api --method=DELETE repos/o/r/issues/1', 'gh api -XPOST repos/o/r/issues', 'gh api -X PUT repos/o/r/pulls/1/merge',
  'gh api graphql -f query="$(cat m.graphql)"', 'gh api graphql -f query="$Q"', "gh api graphql -f query='query { viewer { login } }'",
  'gh api https://api.github.com/graphql -f query="mutation{x}"', 'gh api -X PUT https://api.github.com/repos/o/r/pulls/1/merge',
  'gh api -X PUT repos/o/r/pulls/1//merge', 'gh api repos/o/r/issues -f title=t', 'gh api repos/o/r/issues --input b.json',
  'gh api -Ftitle=t repos/o/r/issues', 'gh pr update-branch 1', 'gh repo sync', 'gh project item-add 1', 'gh pr revert 1',
  'gh repo deploy-key add k', 'gh ssh-key add k', 'gh alias set m "pr merge"', 'gh pr review 1 --approve', 'gh -R o/r pr view 1',
  // re-review: pflag short clusters, any option but --paginate/--jq/-q/-H Accept, graphql in any form
  'gh api -ifbody=x repos/o/r/issues/1/comments', 'gh api -iXPUT repos/o/r/pulls/1/merge', 'gh api -iX DELETE repos/o/r/git/refs/heads/main',
  'gh api -XPOST repos/o/r', 'gh api -X=POST repos/o/r', 'gh api repos/o/r/pulls/1/merge -iX PUT', 'gh api --method get repos/o/r',
  'gh api -X GET repos/o/r/pulls', 'gh api --method GET repos/o/r', 'gh api graphql?x=1', 'gh api /graphql', 'gh api https://api.github.com/graphql',
  'gh api -F x=1 repos', 'gh api -iF x=1 repos', 'gh api -i repos/o/r', 'gh api --include repos/o/r', 'gh api -H X-Evil:1 repos/o/r',
  'gh api repos/o/r repos/o/s', 'gh api', 'gh api --jq', 'gh api --cache 1h repos/o/r', 'gh api --hostname evil.example repos/o/r',
  // re-review: git long options abbreviate
  'git log --outp=/tmp/x', 'git log --out=/tmp/x', 'git diff --outpu /tmp/x HEAD', 'git diff --ext-dif', 'git diff --ext',
  'git show --textconv HEAD', 'git log -p --textconv', 'git log -p --textc',
  // re-review: the test and lint commands run exactly as configured
  'npm test -- --outputFile=/tmp/x --reporter=json', 'npm test --', 'npm test -- a.test.js', 'npx eslint . --fix', 'npx eslint . -o /tmp/x',
  // re-review: nothing may follow a /dev sink in the same word
  "echo hi >/dev/null'x'", 'echo hi >/dev/null"x"', 'echo hi >/dev/nullx',
];
const WRITE_PROBES = [
  `ln -s ${claude}/settings.json x && echo pwn > x`, `ln -sf ${claude} d; cp /etc/hostname d/settings.json`, `ln ${claude}/settings.json h2`,
  `builtin cd ${outside} && echo > a`, `CDPATH=${home} cd outside && echo > a`, `env -C ${outside} sh -c 'echo > a'`,
  `find ${outside} -maxdepth 0 -execdir touch zz \;`, `tee -a ${outside}/x`, `dd of=${outside}/x`, `cp -t ${outside} a`,
  `install -d ${outside}/n`, `rsync a ${outside}/`, `truncate -s0 ${outside}/x`, `echo >| ${outside}/x`, `echo x >|/tmp/x`,
  'echo x 1>|/tmp/x', 'echo x <>/tmp/x', 'exec 3<>/tmp/x', `sed -n 'w ${outside}/x' a`, `sed -n 'w ${claude}/settings.json' a`,
  `awk 'BEGIN{print 1 > "${claude}/settings.json"}'`, `sort -o ${claude}/settings.json a`, `tar -cf ${outside}/x.tar .`,
  `D=${claude}; echo > $D/settings.json`, 'echo > ~root/.claude/settings.json', 'echo > $XDG/../.claude/settings.json',
  "echo '[alias] p = push' >> ~/.gitconfig", `echo > ${outside}/./x/`, `cp a ${root}/cl/settings.json`, 'echo > cl/settings.json',
  'echo > hl', `python3 -c 'open("${claude}/settings.json","w")'`, 'echo hi > a', 'cat a.txt > b', 'git status > out.txt',
  'cat a.txt | tee b', 'git log 2>&1 > x', 'cat --x=~/y', 'cat a:~/y', 'touch a', 'rm a.txt', 'mkdir d', 'cd sub && ls', `cd ${outside} && ls`, 'ls ~root',
];

describe('automação: an allowlist, deny what the guard cannot read', () => {
  for (const command of [...PUSH_PROBES, ...WRITE_PROBES]) {
    it(`denies at every level: ${JSON.stringify(command)}`, () => {
      expect(deniedEverywhere(bash(command))).toBe(true);
    });
  }

  const reads = [
    'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', "git log --format='%H %s' -3", 'git status 2>/dev/null',
    'git diff >/dev/null 2>&1', 'git log 2>&1 | head -5', 'git status && git diff', 'ls -la', 'ls ~', 'cat ~/notes.txt', 'cat a.txt',
    'grep -rn "git push" .', 'rg x src', 'head -5 a.txt', 'tail a.txt', 'wc -l a.txt', 'pwd', 'npm test',
    'npx eslint .', 'gh pr view 3', 'gh issue list', 'gh pr checks 3', 'gh repo view', 'gh api repos/o/r',
    'gh api repos/o/r/pulls --paginate', 'gh api repos/o/r --jq .name', 'gh api repos/o/r -q .name', "gh api -H 'Accept: application/vnd.github.raw' repos/o/r/readme",
    'git log --output-indicator-new=x -p', 'git diff --no-ext-diff', 'git diff --text',
    'echo hi', 'echo "feito: tudo certo"', 'echo ok >/dev/null', 'git status && echo ok', 'pwd',
  ];
  for (const command of reads) {
    it(`lets through at every level: ${command}`, () => {
      for (const level of LEVELS) expect(verdict(bash(command), level), level).toBeNull();
    });
  }

  it('git add and commit only where the level edits', () => {
    for (const command of ['git add a.txt', 'git commit -m "feat: never git push here"', 'git add . && git commit -m x']) {
      expect(verdict(bash(command), 'read')).not.toBeNull();
      expect(verdict(bash(command), 'worktree')).toBeNull();
      expect(verdict(bash(command), 'project')).toBeNull();
    }
  });

  it('the gh writes only on the project level, and never a merge', () => {
    for (const command of ['gh issue create -t x -b y', 'gh issue comment 1 -b y', 'gh pr comment 1 -b y', 'gh pr create -t x -b y', 'gh pr review 1 --comment -b ok']) {
      expect(verdict(bash(command), 'worktree')).not.toBeNull();
      expect(verdict(bash(command), 'project')).toBeNull();
    }
    for (const command of ['gh pr review 1 --approve', 'gh pr review 1 --comment --approve', 'gh pr review 1 -c -a', 'gh pr review 1', 'gh pr merge 1', 'gh issue close 1'])
      expect(verdict(bash(command), 'project'), command).not.toBeNull();
  });

  it('says which level, in pt-BR', () => {
    expect(verdict(bash('true && git push'))).toBe('Automação do Vizor (nível worktree): comando fora do permitido para esta automação.');
    expect(verdict(bash('git push'), 'read')).toContain('(nível ler)');
  });
});

describe('automação: secrets are never read through Bash', () => {
  const SECRET = 'Automação do Vizor: leitura de arquivo sensível barrada.';
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'k');
  fs.writeFileSync(path.join(root, '.env'), 'X=1');
  fs.symlinkSync(path.join(home, '.ssh'), path.join(root, 'keys'));
  const reads = [
    'cat ~/.ssh/id_rsa', `cat ${home}/.ssh/id_rsa`, 'ls ~/.ssh', 'head ~/.gnupg/x', 'cat ~/.config/gh/hosts.yml',
    'cat ~/.claude/.credentials.json', 'cat ~/.git-credentials', 'cat ~/.netrc', 'cat ~/.aws/credentials',
    'cat ~/.config/gcloud/x.json', 'cat ~/.docker/config.json', 'cat ~/.kube/config', 'cat ~/.npmrc', 'cat ~/.pypirc',
    'cat keys/id_rsa', 'cat .env', 'cat sub/.env.local', `cat ${outside}/.env`, 'grep -r token ~', 'grep -rn token ~/.config',
    'rg token ~', 'rg token ~/.config', 'git diff --no-index ~/.ssh/id_rsa /dev/null', "cat '~/.ssh/id_rsa'", 'cat ~/.s"sh"/id_rsa',
    `grep --file=${home}/.netrc x`, 'cat a.txt && cat ~/.netrc',
    'grep -R BEGIN .', 'grep -rnR BEGIN .', 'grep -rn BEGIN --dereference-recursive .', 'rg -L BEGIN .', 'rg -nL BEGIN .', 'rg --follow BEGIN .',
    'grep -f/home/u/.netrc x', 'grep -f .netrc x', 'grep --file .netrc x', 'rg -f.netrc x', 'rg --file=.netrc x',
  ];
  for (const command of reads) {
    it(`denies at every level: ${command}`, () => {
      for (const level of LEVELS) expect(verdict(bash(command), level), level).toBe(SECRET);
      expect(automationVerdict({ rules: MISSING_AUTOMATION_RULES, call: bash(command), cwd: root, home })).toBe(SECRET);
    });
  }
  it('ordinary reads are fine', () => {
    for (const command of ['cat a.txt', 'grep -rn x .', 'rg x', 'ls ~', 'cat ~/notes.txt', 'grep -r x sub', 'ls -la ~/.config/other'])
      expect(verdict(bash(command)), command).toBeNull();
  });
});

// Final review: paths glued to a short option, grep's -d recurse, /proc and rg's hidden files.
describe('automação: secrets behind option spellings', () => {
  const SECRET = 'Automação do Vizor: leitura de arquivo sensível barrada.';
  const reads = [
    // a path glued to a short option is read like a word of its own
    `git commit -F${home}/.ssh/id_rsa`, `git commit -t${home}/.git-credentials -m x`, `gh issue create -t x -F${home}/.ssh/id_rsa`,
    'git commit -F~/.netrc', `git commit -nF${home}/.ssh/id_rsa`, 'git commit -Fkeys/id_rsa', `git commit -F=${home}/.netrc`, 'cat -A~/.netrc',
    // grep -d recurse is -r
    `grep -d recurse -h BEGIN ${home}`, 'grep -drecurse BEGIN ~', 'grep --directories=recurse BEGIN ~', 'grep --directories recurse BEGIN ~',
    'grep --dir=recurse BEGIN ~', 'grep -nd recurse BEGIN ~', 'grep -hdrecurse BEGIN ~', 'grep --rec BEGIN ~', 'grep --recursiv BEGIN ~',
    // the env and memory of a process
    'cat /proc/self/environ', 'cat /proc/1/cmdline', 'head -c 10 /proc/self/mem', 'cat /proc/self/task/1/environ', 'cat /proc/thread-self/environ',
    'grep -r x /proc', 'grep -r x /', 'cat /proc/self/../self/environ',
    'cat /proc/self/cwd/../.netrc', 'cat /proc/self/root/etc/hostname', 'cat /proc/1/fd/3', 'cat /proc/self/task/1/cwd/x',
    // rg reaching hidden or ignored files
    'rg --hidden KEY', 'rg -u KEY', 'rg -uu KEY', 'rg -uuu KEY', 'rg -nu KEY', 'rg --no-ignore KEY', 'rg --no-ignore-vcs KEY',
    'rg --no-ignore-dot KEY', 'rg --unrestricted KEY', 'rg -. KEY', 'rg -n. KEY',
    // the kernel follows a link before its `..`: escape/.. is the home, not the worktree
    'cat escape/../.ssh/id_rsa', `cat ${root}/escape/../.ssh/id_rsa`, 'cat keys/../.ssh/id_rsa',
  ];
  for (const command of reads) {
    it(`denies at every level: ${command}`, () => {
      for (const level of LEVELS) expect(verdict(bash(command), level), level).toBe(SECRET);
    });
  }
  it('grep -d takes only read, skip or recurse, spelled out', () => {
    for (const command of ['grep -d rec x .', 'grep --directories=r x .', 'grep -d foo x .', 'grep -dskipx x .', 'grep --di=rec x .', 'grep -d'])
      expect(deniedEverywhere(bash(command)), command).toBe(true);
  });
  it('an edit through a link and `..` is denied (the kernel would land outside)', () => {
    for (const level of ['worktree', 'project']) {
      expect(verdict(edit(`${root}/escape/../x.txt`), level), level).not.toBeNull();
      expect(verdict(edit(`${root}/sub/../a.txt`), level), level).not.toBeNull();
    }
  });
  it('ordinary option spellings are fine', () => {
    for (const command of [
      'grep -d skip x .', 'grep -d read x a.txt', 'grep -d recurse x sub', 'grep -drecurse x sub', 'grep -n5 x a.txt', 'grep -e-d x a.txt',
      'rg -t js x', 'rg -tjs x', 'rg -n x', 'rg -g x x', 'cat /proc/cpuinfo', 'git log -n5', 'git status -uall', 'git log --since=2.weeks',
    ])
      expect(verdict(bash(command)), command).toBeNull();
    expect(verdict(bash('git commit -Fmsg.txt'), 'worktree')).toBeNull();
  });
});

describe('automação: gh api endpoints carry nothing but a path', () => {
  for (const command of ['gh api repos/o/r?x=1', 'gh api repos/o/r#x', 'gh api repos/o/r%2F', 'gh api https://api.github.com/repos/o/r', 'gh api user@x', 'gh api "repos/o/r x"', `gh api repos/${'a'.repeat(200)}`]) {
    it(`denies at every level: ${command}`, () => expect(deniedEverywhere(bash(command))).toBe(true));
  }
  it('a plain path passes', () => {
    expect(verdict(bash('gh api /repos/o/r/pulls/1/files --paginate'))).toBeNull();
  });
});

describe('automação: tools', () => {
  it('only Read, Grep, Glob, Skill, LS, TodoWrite, Bash and the edit tools', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'Skill', 'LS', 'TodoWrite']) expect(verdict({ tool, input: {} }, 'read')).toBeNull();
    for (const tool of ['mcp__github__merge_pull_request', 'WebFetch', 'WebSearch', 'Task', 'Agent', ''])
      expect(deniedEverywhere({ tool, input: {} }), tool).toBe(true);
  });
});

describe('automação: edit tools', () => {
  it('level 1 denies every edit tool', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(verdict(edit(path.join(root, 'a.txt'), tool), 'read')).not.toBeNull();
  });

  it('edits inside the worktree only, on worktree and project', () => {
    for (const level of ['worktree', 'project']) {
      expect(verdict(edit(path.join(root, 'a.txt')), level)).toBeNull();
      expect(verdict(edit(path.join(root, 'sub', 'new', 'deep.txt'), 'Write'), level)).toBeNull();
    }
  });

  const escapes = [
    ['Edit', path.join(root, 'hl')], // a hard link into ~/.claude
    ['Write', path.join(root, 'cl', 'new.json')], // a symlink to ~/.claude
    ['Write', path.join(root, 'cl', 'settings.json')],
    ['Write', path.join(root, 'escape', 'x')],
    ['Write', path.join(root, 'dangling')],
    ['Write', path.join(root, 'a', '..', '..', 'outside', 'x')],
    ['Write', `${root}-evil/a.txt`],
    ['Write', `${root}/sub/`], // a directory
    ['Write', `${root}/not-yet/`], // a directory that does not exist yet
    ['NotebookEdit', path.join(outside, 'n.ipynb')],
    ['MultiEdit', path.join(claude, 'settings.json')],
    ['Write', '~/.gitconfig'],
    ['Write', path.join(home, '.config', 'git', 'config')],
    ['Write', path.join(home, '.bashrc')],
    ['Write', 'rel/x'],
    ['Write', path.join(root, '.git', 'hooks', 'pre-commit')],
    ['Write', path.join(root, '.claude', 'settings.json')],
    ['Edit', ''],
    ['Write', path.join(root, '.husky', 'pre-commit')], // git hooks run on the allowed commit
    ['Write', path.join(root, '.githooks', 'pre-commit')],
    ['Write', path.join(root, 'sub', '.husky', '_', 'h')],
  ];
  for (const [tool, file] of escapes) {
    it(`denies at every level: ${tool} ${file}`, () => {
      expect(deniedEverywhere(edit(file, tool))).toBe(true);
    });
  }

  it('a notebook edit names one path: notebook_path first, two different paths are denied', () => {
    const inside = path.join(root, 'n.ipynb');
    expect(verdict({ tool: 'NotebookEdit', input: { notebook_path: inside } })).toBeNull();
    expect(verdict({ tool: 'NotebookEdit', input: { notebook_path: inside, file_path: inside } })).toBeNull();
    expect(verdict({ tool: 'NotebookEdit', input: { notebook_path: path.join(outside, 'n.ipynb'), file_path: inside } })).not.toBeNull();
    expect(verdict({ tool: 'Edit', input: { file_path: path.join(root, 'a.txt'), notebook_path: '/etc/x' } })).not.toBeNull();
  });

  it('protected paths hold even when they are inside the root', () => {
    const rules = { ...rulesFor('worktree'), allowEditsUnder: home };
    for (const file of [path.join(claude, 'settings.json'), path.join(home, '.gitconfig'), path.join(home, '.config', 'gh', 'hosts.yml'), path.join(home, '.config', 'vizor', 'automacoes', 'regras.json')])
      expect(automationVerdict({ rules, call: edit(file, 'Write'), home }), file).not.toBeNull();
    expect(automationVerdict({ rules, call: edit(path.join(home, 'ok.txt'), 'Write'), home })).toBeNull();
  });
});

describe('automação without its rules: read only (fail closed)', () => {
  const check = (call) => automationVerdict({ rules: MISSING_AUTOMATION_RULES, call, home });
  for (const command of ['git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD', 'ls -la', 'cat a.txt', 'grep -rn x .', 'rg x', 'head -5 a.txt', 'tail a.txt', 'wc -l a.txt', 'pwd', 'cat a.txt | grep a | wc -l', 'git status 2>/dev/null', 'echo hi'])
    it(`lets read: ${command}`, () => expect(check(bash(command))).toBeNull());
  for (const command of ['echo hi > a', 'git diff --output=x', 'git diff --ext-diff', 'rg --pre ./evil x', 'git -C /x status', 'git --exec-path=. status', 'git commit -m x', 'git push', 'gh pr view 1', 'npm test', 'ls | xargs rm', 'cat a | sh', 'echo $(git push)', "$'git' push", 'git {push,}'])
    it(`denies: ${command}`, () => expect(check(bash(command))).toBe(MISSING));
  it('denies every edit tool and other tools', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(check(edit(path.join(root, 'a.txt'), tool))).toBe(MISSING);
    expect(check({ tool: 'mcp__x__y', input: {} })).toBe(MISSING);
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

  it('reads the entry of this automação, as guardRules wrote it', () => {
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
  it('the filesystem root or the home itself is never a worktree', () => {
    for (const under of ['/', os.homedir()]) {
      const raw = JSON.stringify({ version: 1, automations: { a: { level: 'worktree', denyEdits: false, allowEditsUnder: under, allowBash: [] } } });
      expect(loadAutomationRules(read(raw), file, 'a'), under).toMatchObject({ denyEdits: true, allowEditsUnder: null });
    }
  });
  it('a damaged entry fails closed: bad allowBash items dropped, a relative root means no edits', () => {
    const damaged = JSON.stringify({
      version: 1,
      automations: { a: { level: 'worktree', denyEdits: false, allowEditsUnder: 'rel/dir', allowBash: [{ program: 'git', sub: 'push' }, { program: '/bin/sh' }, null, { program: 'ls' }] } },
    });
    expect(loadAutomationRules(read(damaged), file, 'a')).toEqual({ id: 'a', level: 'worktree', allowBash: [{ program: 'ls' }], denyEdits: true, allowEditsUnder: null });
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
      event: event('cat prod && git push'),
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
      event: event('cat prod'),
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
    const result = await guard('cat "drop table x"', { VIZOR_AUTOMATION: 'auto-1' });
    expect(result.code).toBe(0);
    expect(reasonOf(result)).toContain('Barrado pela regra do usuário');
  });
});
