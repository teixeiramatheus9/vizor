import { describe, it, expect } from 'vitest';
import { changedPaths, parseGitStatusEntries, parseGitStatusZ, settleCandidates } from '../src/main/command-changes.js';

const sigs = (entries) => new Map(Object.entries(entries));

describe('parseGitStatusZ', () => {
  it('lists changed, untracked and renamed paths once', () => {
    expect(parseGitStatusZ(' M a.js\0?? new/b.txt\0R  c.js\0old.js\0 M a.js\0')).toEqual([
      'a.js',
      'new/b.txt',
      'c.js',
    ]);
    expect(parseGitStatusZ('')).toEqual([]);
    expect(parseGitStatusZ(null)).toEqual([]);
  });
});

describe('changedPaths', () => {
  it('reports new, changed and vanished paths, not unchanged ones', () => {
    const before = sigs({ same: '1:1', changed: '1:1', gone: '1:1' });
    const after = sigs({ same: '1:1', changed: '2:2', fresh: '3:3' });
    expect(changedPaths(before, after).sort()).toEqual(['changed', 'fresh', 'gone']);
  });

  it('a file already dirty at the baseline is not a change', () => {
    expect(changedPaths(sigs({ 'pre.txt': '5:5' }), sigs({ 'pre.txt': '5:5' }))).toEqual([]);
  });
});

describe('settleCandidates', () => {
  const never = () => false;

  it('emits a change that stays unexplained for a full cycle, once', () => {
    let state = settleCandidates({ pending: new Map(), changed: ['b.txt'], explained: never, now: 1000 });
    expect(state.emit).toEqual([]);
    state = settleCandidates({ pending: state.pending, changed: [], explained: never, now: 2500 });
    expect(state.emit).toEqual(['b.txt']);
    expect(state.pending.size).toBe(0);
    state = settleCandidates({ pending: state.pending, changed: [], explained: never, now: 4000 });
    expect(state.emit).toEqual([]);
  });

  it('drops a change that an edit hook explains by the next cycle', () => {
    let explainedNow = false;
    const explained = () => explainedNow;
    let state = settleCandidates({ pending: new Map(), changed: ['a.js'], explained, now: 1000 });
    explainedNow = true;
    state = settleCandidates({ pending: state.pending, changed: [], explained, now: 2500 });
    expect(state.emit).toEqual([]);
    expect(state.pending.size).toBe(0);
  });

  it('keeps the first detection time when a path changes again', () => {
    const seen = [];
    const explained = (path, detectedAt) => {
      seen.push(detectedAt);
      return false;
    };
    let state = settleCandidates({ pending: new Map(), changed: ['x'], explained, now: 1000 });
    state = settleCandidates({ pending: state.pending, changed: ['x'], explained, now: 2500 });
    expect(seen.every((at) => at === 1000)).toBe(true);
    expect(state.emit).toEqual(['x']);
  });
});

describe('review fixes (#94)', () => {
  it('tells untracked files apart', () => {
    expect(parseGitStatusEntries(' M a.js\0?? novo.txt\0')).toEqual([
      { path: 'a.js', untracked: false },
      { path: 'novo.txt', untracked: true },
    ]);
  });

  it('a pending change explained but changed again in the same cycle comes back as new', () => {
    let explainedNow = false;
    const explained = () => explainedNow;
    let state = settleCandidates({ pending: new Map(), changed: ['a.js'], explained, now: 1000 });
    explainedNow = true; // the Edit's own write
    state = settleCandidates({ pending: state.pending, changed: ['a.js'], explained, now: 2500 }); // the formatter right after
    expect(state.pending.get('a.js')).toBe(2500);
    explainedNow = false;
    state = settleCandidates({ pending: state.pending, changed: [], explained, now: 4000 });
    expect(state.emit).toEqual(['a.js']);
  });
});
