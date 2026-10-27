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

export function guardRules(a, { worktreePath } = {}) {
  const worktree = a.level === 'worktree';
  // Normalized so `..` cannot widen the allowed tree; relative paths are refused.
  const under = worktree && typeof worktreePath === 'string' && isAbsolute(worktreePath) ? resolve(worktreePath) : null;
  return {
    id: a.id,
    level: a.level,
    denyAlways: [...DENY_ALWAYS],
    denyGhWrite: a.level !== 'project',
    // A worktree level without a usable worktree path fails closed: no edits at all.
    denyEdits: a.level === 'read' || (worktree && !under),
    allowEditsUnder: under,
  };
}
