import { describe, expect, it } from 'vitest';
import { catalogFrom, catalogStale } from '../src/main/work/catalog.js';

const results = { openIssues: [{ number: 12, title: 'do A', labels: [] }], prs: [{ number: 3, title: 'pr do A', isDraft: false }] };

describe('the Ctrl+K catalog', () => {
  it('lists the issues and PRs read for this very project', () => {
    expect(catalogFrom({ results, resultsRoot: '/a', root: '/a' })).toEqual({
      issues: [{ number: 12, title: 'do A' }],
      prs: [{ number: 3, title: 'pr do A' }],
      error: false,
      issuesError: false,
      prsError: false,
    });
  });

  it("I4: another project's lists never show; nothing read is an error", () => {
    expect(catalogFrom({ results, resultsRoot: '/a', root: '/b' })).toEqual({ issues: [], prs: [], error: true, issuesError: true, prsError: true });
    expect(catalogFrom({ results: null, resultsRoot: null, root: '/a' })).toEqual({ issues: [], prs: [], error: true, issuesError: true, prsError: true });
  });

  it('read again when old or read for another project', () => {
    expect(catalogStale({ resultsRoot: '/a', root: '/a', at: 1000, now: 2000, maxAge: 5000 })).toBe(false);
    expect(catalogStale({ resultsRoot: '/a', root: '/a', at: 1000, now: 7000, maxAge: 5000 })).toBe(true);
    expect(catalogStale({ resultsRoot: '/a', root: '/b', at: 1000, now: 2000, maxAge: 5000 })).toBe(true);
  });
});

describe('the Ctrl+K catalog with a failed query', () => {
  it('still lists the issues when the PRs errored, and says the PRs failed', () => {
    const partial = { openIssues: results.openIssues, prs: { error: 'boom' } };
    expect(catalogFrom({ results: partial, resultsRoot: '/a', root: '/a' })).toEqual({
      issues: [{ number: 12, title: 'do A' }],
      prs: [],
      error: false,
      issuesError: false,
      prsError: true,
    });
  });
  it('says the issues failed when only they errored', () => {
    const partial = { openIssues: { error: 'boom' }, prs: results.prs };
    expect(catalogFrom({ results: partial, resultsRoot: '/a', root: '/a' })).toMatchObject({ issuesError: true, prsError: false, error: false });
  });
  it('is an error only when both lists were lost', () => {
    const lost = { openIssues: { error: 'x' }, prs: { error: 'y' } };
    expect(catalogFrom({ results: lost, resultsRoot: '/a', root: '/a' }).error).toBe(true);
  });
});
