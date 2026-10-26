import { describe, expect, it } from 'vitest';
import { catalogFrom, catalogStale } from '../src/main/work/catalog.js';

const results = { openIssues: [{ number: 12, title: 'do A', labels: [] }], prs: [{ number: 3, title: 'pr do A', isDraft: false }] };

describe('the Ctrl+K catalog', () => {
  it('lists the issues and PRs read for this very project', () => {
    expect(catalogFrom({ results, resultsRoot: '/a', root: '/a' })).toEqual({
      issues: [{ number: 12, title: 'do A' }],
      prs: [{ number: 3, title: 'pr do A' }],
      error: false,
    });
  });

  it("I4: another project's lists never show; nothing read is an error", () => {
    expect(catalogFrom({ results, resultsRoot: '/a', root: '/b' })).toEqual({ issues: [], prs: [], error: true });
    expect(catalogFrom({ results: null, resultsRoot: null, root: '/a' })).toEqual({ issues: [], prs: [], error: true });
  });

  it('read again when old or read for another project', () => {
    expect(catalogStale({ resultsRoot: '/a', root: '/a', at: 1000, now: 2000, maxAge: 5000 })).toBe(false);
    expect(catalogStale({ resultsRoot: '/a', root: '/a', at: 1000, now: 7000, maxAge: 5000 })).toBe(true);
    expect(catalogStale({ resultsRoot: '/a', root: '/b', at: 1000, now: 2000, maxAge: 5000 })).toBe(true);
  });
});
