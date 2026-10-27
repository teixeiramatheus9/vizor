// What each automação level may do, as `claude -p` flags and as the extra
// rules the rule-guard enforces. Pure: no IO. The flags are the first barrier;
// the guard is the one that holds (a Bash pattern can be dodged by compound commands).

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
const NEVER = ['git push', 'git merge', 'gh pr merge', 'git branch -D', 'git branch -d'];
const DENY_ALWAYS = ['git push', 'git merge', '--force', 'gh pr merge'];

const bash = (cmds) => cmds.map((c) => `Bash(${c}*)`);

// A test/lint command goes inside a comma-separated Bash(...) pattern, so
// anything that could close or split it is dropped rather than escaped.
const SAFE_CMD = /^[\w@%+=:./ -]+$/;
const cmdTool = (cmd) => (typeof cmd === 'string' && cmd.trim() && SAFE_CMD.test(cmd.trim()) ? `Bash(${cmd.trim()}*)` : null);

export function cliArgs(a, { testCmd, lintCmd, prompt } = {}) {
  const edits = a.level === 'worktree' || a.level === 'project';
  const allowed = [
    ...READ_TOOLS, ...bash(GIT_READ), ...bash(GH_READ),
    ...[cmdTool(testCmd), cmdTool(lintCmd)].filter(Boolean),
    ...(edits ? ['Edit', 'Write', ...bash(GIT_WRITE)] : []),
    ...(a.level === 'project' ? bash(GH_WRITE_PROJECT) : []),
  ];
  const denied = [
    ...(edits ? [] : [...EDIT_TOOLS, ...bash(GIT_WRITE)]),
    ...(a.level === 'project' ? [] : bash(GH_WRITE_ALL)),
    ...bash(NEVER),
  ];
  return [
    '-p', prompt ?? `/vizor-${a.slug}`,
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
  return {
    id: a.id,
    level: a.level,
    denyAlways: [...DENY_ALWAYS],
    denyGhWrite: a.level !== 'project',
    // A worktree level without a worktree fails closed: no edits at all.
    denyEdits: a.level === 'read' || (worktree && !worktreePath),
    allowEditsUnder: worktree && worktreePath ? worktreePath : null,
  };
}
