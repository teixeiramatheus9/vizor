import { describe, it, expect } from 'vitest';
import { reverseEdit } from '../src/main/edit-reverse.js';

const R = (toolName, toolInput, after) => reverseEdit({ toolName, toolInput, after });

describe('reverseEdit', () => {
  it('reverses a single Edit', () => {
    expect(R('Edit', { old_string: 'a = 1', new_string: 'a = 2' }, 'x\na = 2\ny')).toBe('x\na = 1\ny');
  });

  it('never reverses replace_all: occurrences that were already there are indistinguishable', () => {
    const input = { old_string: 'userId', new_string: 'id', replace_all: true };
    expect(R('Edit', input, 'const valid = id;\nconst w = width;')).toBeNull();
    expect(R('Edit', { old_string: 'foo', new_string: 'bar', replace_all: true }, 'bar bar')).toBeNull();
  });

  it('is null when MultiEdit carries a replace_all', () => {
    const edits = [{ old_string: 'a', new_string: 'b', replace_all: true }];
    expect(R('MultiEdit', { edits }, 'b')).toBeNull();
  });

  it('counts overlapping matches, so an overlap is ambiguous', () => {
    expect(R('Edit', { old_string: 'b', new_string: 'aa' }, 'aaa')).toBeNull();
  });

  it('matches LF tool strings against a CRLF file', () => {
    // Claude Code matches on LF-normalized text and keeps the file's endings
    const input = { old_string: 'a = 1\nb', new_string: 'a = 2\nb' };
    expect(R('Edit', input, 'x\r\na = 2\r\nb\r\n')).toBe('x\r\na = 1\r\nb\r\n');
  });

  it('is null when new_string is not in the file', () => {
    expect(R('Edit', { old_string: 'a', new_string: 'b' }, 'zzz')).toBeNull();
  });

  it('is null when new_string is ambiguous without replace_all', () => {
    expect(R('Edit', { old_string: 'a', new_string: 'b' }, 'b b')).toBeNull();
  });

  it('is null for a deletion (empty new_string)', () => {
    expect(R('Edit', { old_string: 'gone', new_string: '' }, 'x')).toBeNull();
  });

  it('replaces literally, never as a pattern', () => {
    expect(R('Edit', { old_string: '$&', new_string: 'a.b' }, 'xa.by')).toBe('x$&y');
  });

  it('reverses MultiEdit in reverse order', () => {
    const edits = [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c' },
    ];
    expect(R('MultiEdit', { edits }, 'c')).toBe('a');
  });

  it('is null when any string arrived truncated', () => {
    expect(R('Edit', { old_string: 'a', new_string: { truncated: 70000 } }, 'x')).toBeNull();
  });

  it('is null for Write and NotebookEdit', () => {
    expect(R('Write', { content: 'x' }, 'x')).toBeNull();
    expect(R('NotebookEdit', {}, 'x')).toBeNull();
  });
});
