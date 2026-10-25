import path from 'node:path';

// "O que temos pra hoje?" (#161): the project's GitHub state from `gh`, read
// only, turned into two spoken sentences and a list for the screen —
// built locally, no tokens.

export function githubRepoOf(remoteUrl) {
  const match = String(remoteUrl ?? '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function ghQueries(repo, defaultBranch) {
  const R = ['-R', repo];
  return {
    prs: ['pr', 'list', '--json', 'number,title,reviewDecision,isDraft,author,statusCheckRollup', '--limit', '50', ...R],
    reviewRequested: ['pr', 'list', '--search', 'review-requested:@me', '--json', 'number,title', '--limit', '50', ...R],
    issues: ['issue', 'list', '--assignee', '@me', '--json', 'number,title', '--limit', '50', ...R],
    runs: ['run', 'list', '--branch', defaultBranch, '--limit', '5', '--json', 'conclusion,headBranch,displayTitle', ...R],
  };
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const ciBroken = (pr) =>
  (pr.statusCheckRollup ?? []).some((check) => FAILED.has(String(check.conclusion ?? check.state ?? '').toUpperCase()));
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function buildDigest(results) {
  if (!results || results.error) return { speech: 'Não consegui falar com o GitHub.', lines: [] };
  const prs = results.prs ?? [];
  const waiting = new Set((results.reviewRequested ?? []).map((pr) => pr.number));
  const issues = results.issues ?? [];
  const brokenPr = prs.find(ciBroken);
  const mainRun = (results.runs ?? [])[0];
  const mainBroken = mainRun && String(mainRun.conclusion ?? '').toLowerCase() === 'failure';

  const lines = [
    ...prs.map((pr) => {
      const notes = [ciBroken(pr) && 'CI quebrado', waiting.has(pr.number) && 'esperando sua revisão', pr.isDraft && 'rascunho'].filter(Boolean);
      return `#${pr.number} ${pr.title}${notes.length ? ` — ${notes.join(', ')}` : ''}`;
    }),
    ...issues.map((issue) => `issue #${issue.number} ${issue.title}`),
    ...(mainBroken ? [`CI da ${mainRun.headBranch} quebrado`] : []),
  ];

  if (!prs.length && !issues.length && !mainBroken) return { speech: 'Nada aberto no GitHub, tudo limpo.', lines };
  const counts = prs.length
    ? `${plural(prs.length, 'PR aberta', 'PRs abertas')}${waiting.size ? `, ${waiting.size} esperando sua revisão` : ''}.`
    : 'Nenhuma PR aberta.';
  const urgent = brokenPr
    ? `O CI da ${brokenPr.number} quebrou.`
    : mainBroken
      ? `O CI da ${mainRun.headBranch} quebrou.`
      : !prs.length && issues.length
        ? `${plural(issues.length, 'issue', 'issues')} com você.`
        : '';
  return { speech: [counts, urgent].filter(Boolean).join(' '), lines };
}

// The focused tab's project, else the bound chat's, else the only one.
export function resolveProject({ focusedCwd, boundCwd, projects }) {
  const owner = (cwd) =>
    cwd ? projects.find((root) => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) : null;
  const root = owner(focusedCwd) ?? owner(boundCwd) ?? (projects.length === 1 ? projects[0] : null);
  return root ? { root } : { ask: true };
}
