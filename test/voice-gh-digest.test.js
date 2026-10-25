import { describe, it, expect } from 'vitest';
import { buildDigest, ghQueries, githubRepoOf, resolveProject } from '../src/main/voice/gh-digest.js';

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
    expect(Object.keys(queries)).toEqual(['prs', 'reviewRequested', 'issues', 'runs']);
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
