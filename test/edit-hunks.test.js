import { describe, it, expect } from 'vitest';
import { MAX_DIFF_BYTES, diffability, diffHunks } from '../src/main/edit-hunks.js';

describe('diffHunks', () => {
  it('counts a one-line change', () => {
    const result = diffHunks('a\nb\nc\n', 'a\nB\nc\n');
    expect([result.added, result.removed]).toEqual([1, 1]);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ newStart: 2, newLines: 1 });
    expect(result.hunks[0].lines).toEqual(['-b', '+B']);
  });

  it('a new file is all additions', () => {
    expect(diffHunks('', 'a\nb\n')).toMatchObject({ added: 2, removed: 0 });
  });

  it('identical content has no hunks', () => {
    expect(diffHunks('a\n', 'a\n')).toEqual({ hunks: [], added: 0, removed: 0 });
  });

  it('CRLF files diff by line, not by every line', () => {
    expect(diffHunks('a\r\nb\r\n', 'a\r\nB\r\n')).toMatchObject({ added: 1, removed: 1 });
  });

  it('a missing trailing newline does not count as an extra change', () => {
    expect(diffHunks('a\nb', 'a\nB')).toMatchObject({ added: 1, removed: 1 });
  });
});

describe('diffability', () => {
  it('flags oversize and binary content', () => {
    expect(diffability('x'.repeat(MAX_DIFF_BYTES + 1))).toBe('too-large');
    expect(diffability('ab\u0000cd')).toBe('binary');
    expect(diffability('fine')).toBe('ok');
  });
});
