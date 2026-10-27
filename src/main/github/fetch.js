// Per-repo GitHub reads for the GitHub tab: issues, mine, PRs, and lazy bodies.
// `gh` is injected (args -> Promise<stdout>) and always gets `-R owner/repo`.
// Deliberately separate from the voice digest's lastGh* state.

const ISSUE_FIELDS = 'number,title,labels,assignees,url,updatedAt';
const PR_FIELDS = 'number,title,author,isDraft,headRefName,reviewDecision,statusCheckRollup,url,labels';
const MAX_BODY = 8000;

export function githubQueries(repo) {
  const R = ['-R', repo];
  return {
    issues: ['issue', 'list', '--state', 'open', '--json', ISSUE_FIELDS, '--limit', '100', ...R],
    mine: ['issue', 'list', '--state', 'open', '--assignee', '@me', '--json', ISSUE_FIELDS, '--limit', '100', ...R],
    prs: ['pr', 'list', '--json', PR_FIELDS, '--limit', '100', ...R],
  };
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const DONE = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const RUNNING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'EXPECTED', 'REQUESTED']);

// 'ok' | 'fail' | 'running' | 'none': a failure wins over a check still running.
export function reduceChecks(rollup) {
  const checks = rollup ?? [];
  if (!checks.length) return 'none';
  const states = checks.map((check) => String(check.conclusion || check.state || check.status || '').toUpperCase());
  if (states.some((state) => FAILED.has(state))) return 'fail';
  if (states.some((state) => !DONE.has(state) || RUNNING.has(state))) return 'running';
  return 'ok';
}

export function createGithubFetcher({ gh, now = Date.now }) {
  const lists = new Map();
  const bodies = new Map();

  async function list(repo) {
    if (lists.has(repo)) return lists.get(repo);
    const entries = Object.entries(githubQueries(repo));
    const settled = await Promise.allSettled(entries.map(async ([, args]) => JSON.parse(await gh(args))));
    const result = { at: now() };
    settled.forEach((outcome, index) => {
      result[entries[index][0]] = outcome.status === 'fulfilled' ? outcome.value : { error: String(outcome.reason?.message ?? outcome.reason) };
    });
    lists.set(repo, result);
    return result;
  }

  async function body(repo, kind, number) {
    const key = `${repo}#${kind}#${number}`;
    if (bodies.has(key)) return bodies.get(key);
    const raw = JSON.parse(await gh([kind === 'pr' ? 'pr' : 'issue', 'view', String(number), '--json', 'body', '-R', repo]));
    const text = String(raw.body ?? '').slice(0, MAX_BODY);
    bodies.set(key, text);
    return text;
  }

  return { list, body };
}
