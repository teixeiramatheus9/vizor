import { describe, expect, it, vi } from 'vitest';
import { createGithubFetcher, githubQueries, reduceChecks } from '../src/main/github/fetch.js';

describe('githubQueries', () => {
  it('puts -R owner/repo on every command', () => {
    const queries = githubQueries('a/b');
    expect(Object.keys(queries)).toEqual(['issues', 'mine', 'prs']);
    for (const args of Object.values(queries)) {
      expect(args[args.indexOf('-R') + 1]).toBe('a/b');
    }
  });

  it('asks for the fields the tabs read', () => {
    const queries = githubQueries('a/b');
    const fields = (args) => args[args.indexOf('--json') + 1];
    expect(fields(queries.issues)).toBe('number,title,labels,assignees,url,updatedAt');
    expect(fields(queries.mine)).toBe('number,title,labels,assignees,url,updatedAt');
    expect(fields(queries.prs)).toBe('number,title,author,isDraft,headRefName,reviewDecision,statusCheckRollup,url,labels');
    expect(queries.mine).toContain('@me');
  });
});

describe('reduceChecks', () => {
  it('has no checks', () => {
    expect(reduceChecks(undefined)).toBe('none');
    expect(reduceChecks([])).toBe('none');
  });
  it('fails when any check failed, even with others running', () => {
    expect(reduceChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('fail');
    expect(reduceChecks([{ state: 'ERROR' }])).toBe('fail');
  });
  it('is running while any check is unfinished', () => {
    expect(reduceChecks([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('running');
    expect(reduceChecks([{ state: 'PENDING' }])).toBe('running');
  });
  it('is ok when everything passed or was skipped', () => {
    expect(reduceChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { state: 'SUCCESS' }])).toBe('ok');
  });
});

describe('createGithubFetcher', () => {
  const json = (value) => JSON.stringify(value);

  it('one failing query never blanks the rest', async () => {
    const gh = vi.fn(async (args) => {
      if (args[0] === 'pr') throw new Error('rate limited');
      return json([{ number: 1, title: 'x' }]);
    });
    const result = await createGithubFetcher({ gh, now: () => 5 }).list('a/b');
    expect(result.issues).toEqual([{ number: 1, title: 'x' }]);
    expect(result.mine).toEqual([{ number: 1, title: 'x' }]);
    expect(result.prs.error).toMatch(/rate limited/);
    expect(result.at).toBe(5);
  });

  it('unparseable output is an error for that key only', async () => {
    const gh = async (args) => (args[0] === 'issue' && !args.includes('@me') ? 'not json' : '[]');
    const result = await createGithubFetcher({ gh }).list('a/b');
    expect(result.issues.error).toBeTruthy();
    expect(result.mine).toEqual([]);
    expect(result.prs).toEqual([]);
  });

  it('finds an issue in what was already read, without calling gh', async () => {
    const gh = vi.fn(async (args) => (args.includes('@me') ? json([{ number: 4, title: 'minha' }]) : args[0] === 'issue' ? json([{ number: 7, title: 'Hello' }]) : '[]'));
    const fetcher = createGithubFetcher({ gh });
    expect(fetcher.cachedIssue('a/b', 7)).toBeNull();
    await fetcher.list('a/b');
    const calls = gh.mock.calls.length;
    expect(fetcher.cachedIssue('a/b', 7)).toMatchObject({ number: 7, title: 'Hello' });
    expect(fetcher.cachedIssue('a/b', 4)).toMatchObject({ title: 'minha' });
    expect(fetcher.cachedIssue('a/b', 99)).toBeNull();
    expect(fetcher.cachedIssue('c/d', 7)).toBeNull();
    expect(gh).toHaveBeenCalledTimes(calls);
  });

  it('caches the list per repo', async () => {
    const gh = vi.fn(async () => '[]');
    const fetcher = createGithubFetcher({ gh });
    await fetcher.list('a/b');
    await fetcher.list('a/b');
    expect(gh).toHaveBeenCalledTimes(3);
    await fetcher.list('c/d');
    expect(gh).toHaveBeenCalledTimes(6);
  });

  it('never caches an {error} key and reads it again next time', async () => {
    let fail = true;
    const gh = vi.fn(async (args) => {
      if (args[0] === 'pr' && fail) throw new Error('rate limited');
      return '[]';
    });
    const fetcher = createGithubFetcher({ gh });
    expect((await fetcher.list('a/b')).prs.error).toBeTruthy();
    fail = false;
    const again = await fetcher.list('a/b');
    expect(again.prs).toEqual([]);
    expect(again.issues).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(4); // only prs was read again
    await fetcher.list('a/b');
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it('force reads everything again', async () => {
    const gh = vi.fn(async () => '[]');
    const fetcher = createGithubFetcher({ gh });
    await fetcher.list('a/b');
    await fetcher.list('a/b', { force: true });
    expect(gh).toHaveBeenCalledTimes(6);
  });

  it('body is lazy, cached and cut at 8000 characters', async () => {
    const gh = vi.fn(async () => json({ body: 'x'.repeat(9000) }));
    const fetcher = createGithubFetcher({ gh });
    const first = await fetcher.body('a/b', 'pr', 7);
    expect(first.length).toBe(8000);
    await fetcher.body('a/b', 'pr', 7);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0][0]).toEqual(['pr', 'view', '7', '--json', 'body', '-R', 'a/b']);
    await fetcher.body('a/b', 'issue', 7);
    expect(gh.mock.calls[1][0][0]).toBe('issue');
  });

  it('a failed body is not cached', async () => {
    const gh = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(json({ body: 'ok' }));
    const fetcher = createGithubFetcher({ gh });
    await expect(fetcher.body('a/b', 'pr', 1)).rejects.toThrow('boom');
    expect(await fetcher.body('a/b', 'pr', 1)).toBe('ok');
  });
});
