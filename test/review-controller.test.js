import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_TEXT,
  clampDrawerHeight,
  composerTarget,
  hunkContext,
  hunkInRange,
  nodeContext,
  nodeOfHunk,
  requestText,
  verdictAction,
} from '../src/renderer/review/review-controller.js';
import { EXPLAIN_TEXT as MAIN_EXPLAIN_TEXT } from '../src/main/review/compose.js';

describe('the review wiring helpers', () => {
  it('keeps the explain text in step with main', () => {
    expect(EXPLAIN_TEXT).toBe(MAIN_EXPLAIN_TEXT);
  });

  it('clamps the drawer between 120 px and 70% of the column', () => {
    expect(clampDrawerHeight(50, 1000)).toBe(120);
    expect(clampDrawerHeight(900, 1000)).toBe(700);
    expect(clampDrawerHeight(333, 1000)).toBe(333);
    expect(clampDrawerHeight(undefined, 1000)).toBe(300);
    expect(clampDrawerHeight(400, 100)).toBe(120);
  });

  it('writes the request as the issue or the first prompt', () => {
    expect(requestText({ kind: 'issue', number: 169, title: 'Menu', body: 'corpo' })).toBe('#169 Menu\n\ncorpo');
    expect(requestText({ kind: 'issue', number: 7, title: 'X', body: '' })).toBe('#7 X');
    expect(requestText({ kind: 'prompt', text: 'faz aí' })).toBe('faz aí');
    expect(requestText(null)).toBe('');
  });

  it('builds the compose contexts compose.js expects', () => {
    expect(hunkContext('a.js', { id: 'h', newStart: 4, newLines: 2, lines: [] })).toEqual({ kind: 'hunk', path: 'a.js', newStart: 4, newLines: 2 });
    expect(nodeContext({ id: 'a.js#run', label: 'run', files: ['a.js'], range: { startLine: 3, endLine: 9 } }))
      .toEqual({ kind: 'node', label: 'run', path: 'a.js', startLine: 3, endLine: 9 });
    expect(nodeContext({ id: 'b.js', label: 'b.js', files: ['b.js'], range: null })).toEqual({ kind: 'node', label: 'b.js', path: 'b.js' });
  });

  it('tells whether a hunk touches a range, a deletion by its line', () => {
    expect(hunkInRange({ newStart: 5, newLines: 3 }, { startLine: 7, endLine: 9 })).toBe(true);
    expect(hunkInRange({ newStart: 10, newLines: 3 }, { startLine: 7, endLine: 9 })).toBe(false);
    expect(hunkInRange({ newStart: 8, newLines: 0 }, { startLine: 7, endLine: 9 })).toBe(true);
    expect(hunkInRange({ newStart: 1, newLines: 1 }, null)).toBe(true);
  });

  it('lights the smallest function around a hunk, else its file', () => {
    const slice = {
      nodes: [
        { id: 'a.js', files: ['a.js'], range: null },
        { id: 'a.js#outer', files: ['a.js'], range: { startLine: 1, endLine: 50 } },
        { id: 'a.js#inner', files: ['a.js'], range: { startLine: 10, endLine: 20 } },
        { id: 'b.js', files: ['b.js'], range: null },
      ],
    };
    expect(nodeOfHunk(slice, 'a.js', { newStart: 12, newLines: 2 })).toBe('a.js#inner');
    expect(nodeOfHunk(slice, 'a.js', { newStart: 30, newLines: 2 })).toBe('a.js#outer');
    expect(nodeOfHunk(slice, 'b.js', { newStart: 30, newLines: 2 })).toBe('b.js');
    expect(nodeOfHunk(slice, 'c.js', { newStart: 1, newLines: 1 })).toBeNull();
    expect(nodeOfHunk(null, 'a.js', { newStart: 1, newLines: 1 })).toBeNull();
  });

  it('writes to the picked chat while it is there, else the agent, else the first', () => {
    const sessions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    expect(composerTarget(sessions, 'b', 'a').sessionId).toBe('b');
    expect(composerTarget(sessions, 'gone', 'a')).toMatchObject({ sessionId: 'a', sessionLabel: 'A' });
    expect(composerTarget(sessions, null, null).sessionId).toBe('a');
    expect(composerTarget([], null, null)).toMatchObject({ sessionId: null, sessionLabel: 'nenhum chat neste worktree' });
  });

  it('sends each verdict item to its detail; tsc and tests run', () => {
    expect(verdictAction('tsc')).toEqual({ verify: 'tsc' });
    expect(verdictAction('tests')).toEqual({ verify: 'tests' });
    expect(verdictAction('untested')).toEqual({ tab: 'impact' });
    expect(verdictAction('contract')).toEqual({ tab: 'changes' });
    expect(verdictAction('review')).toEqual({ tab: 'changes' });
  });
});
