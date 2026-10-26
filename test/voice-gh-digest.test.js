import { describe, it, expect } from 'vitest';
import { buildDigest, ghQueries, githubRepoOf, managerContext, resolveProject } from '../src/main/voice/gh-digest.js';

const failing = [{ __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }];
const passing = [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }];

describe('buildDigest', () => {
  it('counts first, then the single most urgent thing', () => {
    const digest = buildDigest({
      prs: [
        { number: 158, title: 'leva A', isDraft: false, statusCheckRollup: failing },
        { number: 164, title: 'trava', isDraft: false, statusCheckRollup: passing },
        { number: 170, title: 'voz', isDraft: true, statusCheckRollup: [] },
      ],
      reviewRequested: [{ number: 164, title: 'trava' }],
      issues: [{ number: 161, title: 'voz' }],
      runs: [{ conclusion: 'success', headBranch: 'main' }],
    });
    expect(digest.speech).toBe('3 PRs abertas, 1 esperando sua revisão. O CI da 158 quebrou.');
    expect(digest.lines).toEqual(expect.arrayContaining(['#158 leva A — CI quebrado', '#164 trava — esperando sua revisão', '#170 voz — rascunho', 'issue #161 voz']));
  });

  it('a broken default branch counts when no PR is broken', () => {
    const digest = buildDigest({ prs: [{ number: 1, title: 'x', statusCheckRollup: passing }], reviewRequested: [], issues: [], runs: [{ conclusion: 'failure', headBranch: 'main' }] });
    expect(digest.speech).toBe('1 PR aberta. O CI da main quebrou.');
  });

  it('nothing open is said as such', () => {
    expect(buildDigest({ prs: [], reviewRequested: [], issues: [], runs: [] }).speech).toBe('Nada aberto no GitHub, tudo limpo.');
  });

  it('assigned issues are mentioned when there is nothing else', () => {
    expect(buildDigest({ prs: [], reviewRequested: [], issues: [{ number: 9, title: 'x' }, { number: 10, title: 'y' }], runs: [] }).speech).toBe(
      'Nenhuma PR aberta. 2 issues com você.',
    );
  });

  it('gh failing is said, never thrown', () => {
    expect(buildDigest({ error: 'gh: not logged in' }).speech).toBe('Não consegui falar com o GitHub.');
  });
});

describe('githubRepoOf / ghQueries', () => {
  it('reads owner/repo from both remote styles', () => {
    expect(githubRepoOf('git@github.com:teixeiramatheus9/vizor.git')).toBe('teixeiramatheus9/vizor');
    expect(githubRepoOf('https://github.com/teixeiramatheus9/vizor')).toBe('teixeiramatheus9/vizor');
    expect(githubRepoOf('https://gitlab.com/x/y.git')).toBeNull();
  });

  it('every query names the repo explicitly', () => {
    const queries = ghQueries('o/r', 'main');
    expect(Object.keys(queries)).toEqual(['prs', 'reviewRequested', 'issues', 'openIssues', 'runs']);
    expect(queries.openIssues).toEqual(expect.arrayContaining(['issue', 'list', '--state', 'open']));
    expect(queries.prs.join(' ')).toContain('reviewRequests');
    for (const args of Object.values(queries)) expect(args.slice(-2)).toEqual(['-R', 'o/r']);
    expect(queries.runs).toEqual(expect.arrayContaining(['--branch', 'main']));
  });
});

describe('resolveProject', () => {
  const projects = ['/home/u/vizor', '/home/u/outro'];
  it('the focused tab wins, then the bound chat, then the only project', () => {
    expect(resolveProject({ focusedCwd: '/home/u/vizor/src', boundCwd: '/home/u/outro', projects })).toEqual({ root: '/home/u/vizor' });
    expect(resolveProject({ focusedCwd: null, boundCwd: '/home/u/outro/x', projects })).toEqual({ root: '/home/u/outro' });
    expect(resolveProject({ focusedCwd: null, boundCwd: null, projects: ['/home/u/vizor'] })).toEqual({ root: '/home/u/vizor' });
    expect(resolveProject({ focusedCwd: null, boundCwd: null, projects })).toEqual({ ask: true });
    expect(resolveProject({ focusedCwd: '/home/u/vizorx', boundCwd: null, projects })).toEqual({ ask: true });
  });
});

describe('buildDigest in English, for an English voice', () => {
  it('says the counts and the urgent bit in English; the screen lines stay as they are', () => {
    const digest = buildDigest(
      {
        prs: [
          { number: 7, title: 'auth', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
          { number: 8, title: 'ui', statusCheckRollup: [] },
        ],
        reviewRequested: [{ number: 8 }],
        issues: [],
        runs: [],
      },
      'en',
    );
    expect(digest.speech).toBe('2 open PRs, 1 waiting for your review. The CI on 7 broke.');
    expect(digest.lines[0]).toBe('#7 auth — CI quebrado');
  });

  it('nothing open, one PR, issues only, a broken main, and no GitHub', () => {
    expect(buildDigest({ prs: [], issues: [], runs: [] }, 'en').speech).toBe('Nothing open on GitHub, all clear.');
    expect(buildDigest({ prs: [{ number: 1, title: 'x' }], issues: [], runs: [] }, 'en').speech).toBe('1 open PR.');
    expect(buildDigest({ prs: [], issues: [{ number: 3, title: 'y' }, { number: 4, title: 'z' }], runs: [] }, 'en').speech).toBe('No open PRs. 2 issues on you.');
    expect(buildDigest({ prs: [], issues: [], runs: [{ conclusion: 'failure', headBranch: 'main' }] }, 'en').speech).toBe('No open PRs. The CI on main broke.');
    expect(buildDigest({ error: 'x' }, 'en').speech).toBe("I couldn't reach GitHub.");
  });
});

describe('managerContext: what the gerente reads (it reads, the músicos act)', () => {
  const results = {
    prs: [
      { number: 166, title: 'modo voz', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: passing, reviewRequests: [{ login: 'alexsynvia' }], author: { login: 'teixeiramatheus9' } },
      { number: 150, title: 'leva A', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: failing, reviewRequests: [], author: { login: 'joao' } },
    ],
    reviewRequested: [{ number: 150 }],
    issues: [{ number: 142, title: 'logs' }],
    openIssues: [
      { number: 142, title: 'Workspace: monitorar sub-agentes', labels: [{ name: 'workspace' }], assignees: [{ login: 'teixeiramatheus9' }] },
      { number: 45, title: 'Conectar com outras IAs', labels: [], assignees: [] },
    ],
    runs: [{ conclusion: 'success', headBranch: 'main' }],
  };

  it('every open PR with its review state, checks and reviewers; every open issue with labels and owner', () => {
    const text = managerContext(results);
    expect(text).toContain('PR #166 modo voz — revisão pendente; checks ok; revisores pedidos: alexsynvia; autor teixeiramatheus9');
    expect(text).toContain('PR #150 leva A — rascunho; mudanças pedidas; CI quebrado; esperando sua revisão; autor joao');
    expect(text).toContain('issue #142 Workspace: monitorar sub-agentes [workspace] — com teixeiramatheus9');
    expect(text).toContain('issue #45 Conectar com outras IAs — sem responsável');
    expect(text).toContain('CI da main: ok');
  });

  it('a GitHub failure says so; at most 40 issues', () => {
    expect(managerContext({ error: 'x' })).toBe('GitHub indisponível agora.');
    const many = { ...results, openIssues: Array.from({ length: 60 }, (_, index) => ({ number: index + 1, title: `i${index}`, labels: [], assignees: [] })) };
    expect(managerContext(many).match(/^issue #/gm)).toHaveLength(40);
  });
});
