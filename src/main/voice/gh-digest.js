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
    prs: ['pr', 'list', '--json', 'number,title,reviewDecision,isDraft,author,statusCheckRollup,reviewRequests', '--limit', '50', ...R],
    reviewRequested: ['pr', 'list', '--search', 'review-requested:@me', '--json', 'number,title', '--limit', '50', ...R],
    issues: ['issue', 'list', '--assignee', '@me', '--json', 'number,title', '--limit', '50', ...R],
    // Every open issue, for the gerente: "puxa uma das issues" must see them all.
    openIssues: ['issue', 'list', '--state', 'open', '--json', 'number,title,labels,assignees', '--limit', '60', ...R],
    runs: ['run', 'list', '--branch', defaultBranch, '--limit', '5', '--json', 'conclusion,headBranch,displayTitle', ...R],
  };
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const ciBroken = (pr) =>
  (pr.statusCheckRollup ?? []).some((check) => FAILED.has(String(check.conclusion ?? check.state ?? '').toUpperCase()));
// One failing query comes back as `{ error }` instead of a list: skip that key
// and say it, so the others still count.
const list = (value) => (Array.isArray(value) ? value : []);
const KEY_LABEL = {
  pt: { prs: 'as PRs', reviewRequested: 'os pedidos de revisão', issues: 'as issues', openIssues: 'as issues', runs: 'o CI' },
  en: { prs: 'the PRs', reviewRequested: 'the review requests', issues: 'the issues', openIssues: 'the issues', runs: 'the CI' },
};
const unreadLabels = (results, lang) => [
  ...new Set(Object.keys(KEY_LABEL.pt).filter((key) => results?.[key] && !Array.isArray(results[key])).map((key) => KEY_LABEL[lang][key])),
];
const cantRead = (results, lang) => {
  const labels = unreadLabels(results, lang);
  if (!labels.length) return '';
  return lang === 'en' ? `I couldn't read ${labels.join(' or ')}.` : `Não consegui ler ${labels.join(' nem ')}.`;
};
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// The speech follows the voice's language; the lines are for the screen.
const SPEECH = {
  pt: {
    unreachable: 'Não consegui falar com o GitHub.',
    clear: 'Nada aberto no GitHub, tudo limpo.',
    prs: (count) => plural(count, 'PR aberta', 'PRs abertas'),
    waiting: (count) => `${count} esperando sua revisão`,
    noPrs: 'Nenhuma PR aberta.',
    ciBroke: (where) => `O CI da ${where} quebrou.`,
    issues: (count) => `${plural(count, 'issue', 'issues')} com você.`,
  },
  en: {
    unreachable: "I couldn't reach GitHub.",
    clear: 'Nothing open on GitHub, all clear.',
    prs: (count) => plural(count, 'open PR', 'open PRs'),
    waiting: (count) => `${count} waiting for your review`,
    noPrs: 'No open PRs.',
    ciBroke: (where) => `The CI on ${where} broke.`,
    issues: (count) => `${plural(count, 'issue', 'issues')} on you.`,
  },
};

export function buildDigest(results, lang = 'pt') {
  const say = SPEECH[lang] ?? SPEECH.pt;
  if (!results || results.error) return { speech: say.unreachable, lines: [] };
  const prs = list(results.prs);
  const waiting = new Set(list(results.reviewRequested).map((pr) => pr.number));
  const issues = list(results.issues);
  const brokenPr = prs.find(ciBroken);
  const mainRun = list(results.runs)[0];
  const unread = cantRead(results, SPEECH[lang] ? lang : 'pt');
  const mainBroken = mainRun && String(mainRun.conclusion ?? '').toLowerCase() === 'failure';

  const lines = [
    ...prs.map((pr) => {
      const notes = [ciBroken(pr) && 'CI quebrado', waiting.has(pr.number) && 'esperando sua revisão', pr.isDraft && 'rascunho'].filter(Boolean);
      return `#${pr.number} ${pr.title}${notes.length ? ` — ${notes.join(', ')}` : ''}`;
    }),
    ...issues.map((issue) => `issue #${issue.number} ${issue.title}`),
    ...(mainBroken ? [`CI da ${mainRun.headBranch} quebrado`] : []),
    ...unreadLabels(results, 'pt').map((label) => `não consegui ler ${label}`),
  ];

  if (!prs.length && !issues.length && !mainBroken) return { speech: unread || say.clear, lines };
  const counts = prs.length ? `${say.prs(prs.length)}${waiting.size ? `, ${say.waiting(waiting.size)}` : ''}.` : say.noPrs;
  const urgent = brokenPr
    ? say.ciBroke(brokenPr.number)
    : mainBroken
      ? say.ciBroke(mainRun.headBranch)
      : !prs.length && issues.length
        ? say.issues(issues.length)
        : '';
  return { speech: [counts, urgent, unread].filter(Boolean).join(' '), lines };
}

// The focused tab's project, else the bound chat's, else the only one.
export function resolveProject({ focusedCwd, boundCwd, projects }) {
  const owner = (cwd) =>
    cwd ? projects.find((root) => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) : null;
  const root = owner(focusedCwd) ?? owner(boundCwd) ?? (projects.length === 1 ? projects[0] : null);
  return root ? { root } : { ask: true };
}

// What the gerente reads with each question (#159: the gerente reads, the
// músicos act). Built locally from the same gh results, so it costs no tool
// calls: one line per open PR and per open issue (at most 40), in pt-BR.
const MAX_CONTEXT_ISSUES = 40;
const DECISION = { REVIEW_REQUIRED: 'revisão pendente', CHANGES_REQUESTED: 'mudanças pedidas', APPROVED: 'aprovada' };
const names = (people) => (people ?? []).map((person) => person.login ?? person.name).filter(Boolean);

export function managerContext(results) {
  if (!results || results.error) return 'GitHub indisponível agora.';
  const waiting = new Set(list(results.reviewRequested).map((pr) => pr.number));
  const prs = list(results.prs).map((pr) => {
    const checks = pr.statusCheckRollup ?? [];
    const notes = [
      pr.isDraft && 'rascunho',
      DECISION[pr.reviewDecision],
      ciBroken(pr) ? 'CI quebrado' : checks.length ? 'checks ok' : null,
      names(pr.reviewRequests).length && `revisores pedidos: ${names(pr.reviewRequests).join(', ')}`,
      waiting.has(pr.number) && 'esperando sua revisão',
      pr.author?.login && `autor ${pr.author.login}`,
    ].filter(Boolean);
    return `PR #${pr.number} ${pr.title}${notes.length ? ` — ${notes.join('; ')}` : ''}`;
  });
  const issues = list(results.openIssues).slice(0, MAX_CONTEXT_ISSUES).map((issue) => {
    const labels = names((issue.labels ?? []).map((label) => ({ name: label.name })));
    const owners = names(issue.assignees);
    return `issue #${issue.number} ${issue.title}${labels.length ? ` [${labels.join(', ')}]` : ''} — ${owners.length ? `com ${owners.join(', ')}` : 'sem responsável'}`;
  });
  const run = list(results.runs)[0];
  const ci = run ? [`CI da ${run.headBranch}: ${String(run.conclusion ?? '').toLowerCase() === 'failure' ? 'quebrado' : run.conclusion === 'success' ? 'ok' : run.conclusion || 'rodando'}`] : [];
  const unread = unreadLabels(results, 'pt').map((label) => `(não consegui ler ${label})`);
  return [...prs, ...issues, ...ci, ...unread].join('\n') || 'Nada aberto no GitHub.';
}
