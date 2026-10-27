// What each automação level may do, as `claude -p` flags and as the extra
// rules the rule-guard enforces. Pure: no IO. The flags are the first barrier;
// the guard is the one that holds (a Bash pattern can be dodged by compound commands).
import { isAbsolute, resolve } from 'node:path';

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Skill'];
const GIT_READ = ['log', 'diff', 'status', 'show'].map((c) => `git ${c}`);
const GH_READ = ['issue list', 'issue view', 'pr list', 'pr view', 'pr checks', 'pr diff'].map((c) => `gh ${c}`);
const GH_WRITE_ALL = [
  'issue create', 'issue comment', 'issue close', 'issue edit',
  'pr create', 'pr comment', 'pr review', 'pr close', 'pr edit',
].map((c) => `gh ${c}`);
const GH_WRITE_PROJECT = ['gh issue create', 'gh issue comment', 'gh pr comment'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const GIT_WRITE = ['git add', 'git commit'];
// Never, at any level (the user's own guard rules stack on top of these).
const DENY_ALWAYS = [
  'git push', 'git merge', '--force', 'gh pr merge',
  'git branch -D', 'git branch -d', 'git reset --hard', 'git clean -f', 'git push --force-with-lease',
];
// Same list as flags, so the flags and the guard agree (a bare flag has no command to anchor on).
const NEVER = DENY_ALWAYS.map((c) => (c.startsWith('--') ? `* ${c}` : c));
// Edits are scoped by acceptEdits to the cwd; these paths are denied on top
// because the Claude config is where a hook or permission could be rewritten.
const PROTECTED_PATHS = ['~/.claude/**', '~/.config/vizor/**'];
// The Read tool never reaches the guard (its matcher), so the secrets the
// guard keeps Bash off are denied here too. Tilde/glob form of the Read rule
// is assumed from the permission syntax, not verified at runtime.
const SECRET_DIRS = ['~/.ssh', '~/.gnupg', '~/.config/gh', '~/.aws', '~/.config/gcloud', '~/.kube'];
const SECRET_FILES = ['~/.claude/.credentials.json', '~/.git-credentials', '~/.netrc', '~/.docker/config.json', '~/.npmrc', '~/.pypirc'];
const SECRET_READS = [...SECRET_DIRS.map((d) => `Read(${d}/**)`), ...SECRET_FILES.map((f) => `Read(${f})`), 'Read(**/.env)', 'Read(**/.env.*)'];
const GIT_OUTPUT = ['git diff', 'git log', 'git show'].map((c) => `${c} *--output*`);

// `cmd` alone and `cmd *`: the separator keeps `git logx` / `npm test-x` from matching.
const bash = (cmds) => cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);

// A test/lint command goes inside a comma-separated Bash(...) pattern, so
// anything that could close or split it is dropped rather than escaped.
const SAFE_CMD = /^[\w@%+=:./ -]+$/;
const safeCmd = (cmd) => (typeof cmd === 'string' && cmd.trim() && SAFE_CMD.test(cmd.trim()) ? cmd.trim() : null);

export function cliArgs(a, { testCmd, lintCmd, prompt } = {}) {
  const text = prompt ?? `/vizor-${a.slug}`;
  // A leading "/" keeps the prompt from ever being read as a flag.
  if (typeof text !== 'string' || !text.startsWith('/')) throw new Error('automação prompt must start with "/"');
  if (!Number.isFinite(a.capUsd) || a.capUsd <= 0) throw new Error('automação cap must be a positive number');
  if (typeof a.model !== 'string' || !/^[\w.[\]-]+$/.test(a.model)) throw new Error('automação model is invalid');
  const edits = a.level === 'worktree' || a.level === 'project';
  const allowed = [
    ...READ_TOOLS, ...bash(GIT_READ), ...bash(GH_READ),
    ...bash([safeCmd(testCmd), safeCmd(lintCmd)].filter(Boolean)),
    // No bare Edit/Write: they would be unscoped. acceptEdits already allows edits inside the cwd.
    ...(edits ? bash(GIT_WRITE) : []),
    ...(a.level === 'project' ? bash(GH_WRITE_PROJECT) : []),
  ];
  const denied = [
    ...(edits ? [] : [...EDIT_TOOLS, ...bash(GIT_WRITE)]),
    ...(a.level === 'project' ? [] : bash(GH_WRITE_ALL)),
    ...bash(NEVER),
    ...GIT_OUTPUT.map((c) => `Bash(${c})`),
    ...(edits ? PROTECTED_PATHS.flatMap((p) => [`Edit(${p})`, `Write(${p})`]) : []),
    ...SECRET_READS,
  ];
  return [
    '-p', text,
    '--output-format', 'json',
    '--permission-mode', edits ? 'acceptEdits' : 'dontAsk',
    '--allowedTools', allowed.join(','),
    '--disallowedTools', denied.join(','),
    '--max-budget-usd', String(a.capUsd),
    '--model', a.model,
  ];
}

// A test/lint command as the guard's allowlist entry: `npm test` → npm +
// test, run exactly as configured. Extra words could point a runner's output
// anywhere (--outputFile), fix files (--fix) or run code (-exec), so none.
function commandEntry(cmd) {
  const safe = safeCmd(cmd);
  if (!safe) return null;
  const [program, ...argsPrefix] = safe.split(/\s+/);
  return { program, argsPrefix, extra: 'none' };
}

// Read-only helpers the guard lets through at every level.
// echo only prints: the guard refuses any redirection but /dev/*.
const READ_PROGRAMS = ['ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'pwd', 'echo'];
const GH_READ_GUARD = [
  ['issue', 'list'], ['issue', 'view'], ['issue', 'status'],
  ['pr', 'list'], ['pr', 'view'], ['pr', 'status'], ['pr', 'checks'], ['pr', 'diff'],
  ['repo', 'view'], ['api'], // gh api: the guard lets only a plain GET through
];
const GH_WRITE_GUARD = [['issue', 'create'], ['issue', 'comment'], ['pr', 'create'], ['pr', 'comment']];

// The Bash commands the guard allows for a level: an allowlist, so anything
// it cannot match (wrappers, expansions, other programs) is denied.
function allowBash(level, { testCmd, lintCmd } = {}) {
  const edits = level === 'worktree' || level === 'project';
  return [
    { program: 'git', sub: ['log', 'diff', 'status', 'show', ...(edits ? ['add', 'commit'] : [])] },
    ...READ_PROGRAMS.map((program) => ({ program })),
    ...GH_READ_GUARD.map((argsPrefix) => ({ program: 'gh', argsPrefix })),
    ...(level === 'project'
      ? [
          ...GH_WRITE_GUARD.map((argsPrefix) => ({ program: 'gh', argsPrefix })),
          { program: 'gh', argsPrefix: ['pr', 'review'], requireArgs: ['--comment', '-c'], forbidArgs: ['--approve', '-a', '--request-changes', '-r'] },
        ]
      : []),
    ...[commandEntry(testCmd), commandEntry(lintCmd)].filter(Boolean),
  ];
}

// What the rule-guard holds this automação to (it writes regras.json with one
// of these per id). Edits are allowed only under the worktree.
export function guardRules(a, { worktreePath, testCmd, lintCmd } = {}) {
  const edits = a.level === 'worktree' || a.level === 'project';
  // Normalized so `..` cannot widen the allowed tree; relative paths are refused.
  const under = edits && typeof worktreePath === 'string' && isAbsolute(worktreePath) ? resolve(worktreePath) : null;
  return {
    id: a.id,
    level: a.level,
    allowBash: allowBash(a.level, { testCmd, lintCmd }),
    // A level that edits but has no usable worktree path fails closed: no edits at all.
    denyEdits: !under,
    allowEditsUnder: under,
  };
}

// Tokens and agents that could push or write to GitHub from inside a test
// script, where the guard cannot see.
const PUSH_CREDENTIALS = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];
// Every push URL is rewritten to a scheme git cannot reach (pushInsteadOf is
// multi-valued: one entry per prefix). '/' and file:// cover local remotes.
const PUSH_PREFIXES = ['https://', 'http://', 'ssh://', 'git@', 'git://', 'file://', '/'];
const NO_PUSH_CONFIG = [
  ['credential.helper', ''], // an empty value clears every helper
  ...PUSH_PREFIXES.map((prefix) => ['url.invalid://vizor-automation/.pushInsteadOf', prefix]),
  ['push.default', 'nothing'],
];

// The env of an automação's run: push disabled at the process level for
// every level, on top of the CLI flags and the guard. Pure: baseEnv is copied.
export function runEnv(a, baseEnv = {}) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    // The run's own git config replaces any the parent passed down.
    if (PUSH_CREDENTIALS.includes(name) || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, {
    VIZOR_INTERNAL: '1',
    VIZOR_AUTOMATION: String(a.id),
    VIZOR_GUARD_ASK_MS: '300000',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_CONFIG_COUNT: String(NO_PUSH_CONFIG.length),
  });
  NO_PUSH_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}
