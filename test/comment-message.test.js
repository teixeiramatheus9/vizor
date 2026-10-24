import { describe, it, expect } from 'vitest';
import {
  MAX_COMMENT_CHARS,
  bracketedPaste,
  buildCommentMessage,
  commentHeader,
  flattenForTyping,
  validateComment,
} from '../src/main/comment-message.js';

const edit = (extra = {}) => ({
  seq: 1,
  relPath: 'src/a.js',
  status: 'applied',
  hunks: [{ oldStart: 14, oldLines: 2, newStart: 14, newLines: 5, lines: [] }],
  ...extra,
});

describe('commentHeader', () => {
  it('names the file, the lines and the edit', () => {
    expect(commentHeader(edit())).toBe('Sobre src/a.js, linhas 14–18 (sua edição #1):');
  });

  it('says "linha" for a single line', () => {
    expect(commentHeader(edit({ hunks: [{ oldStart: 14, oldLines: 1, newStart: 14, newLines: 1 }] }))).toBe(
      'Sobre src/a.js, linha 14 (sua edição #1):',
    );
  });

  it('spans from the first hunk to the last', () => {
    const hunks = [
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 },
      { oldStart: 40, oldLines: 0, newStart: 41, newLines: 3 },
    ];
    expect(commentHeader(edit({ hunks }))).toBe('Sobre src/a.js, linhas 3–43 (sua edição #1):');
  });

  it('points near a deletion', () => {
    expect(commentHeader(edit({ hunks: [{ oldStart: 7, oldLines: 2, newStart: 6, newLines: 0 }] }))).toBe(
      'Sobre src/a.js, perto da linha 7 (sua edição #1):',
    );
  });

  it('drops the lines when there is no diff', () => {
    expect(commentHeader(edit({ hunks: [] }))).toBe('Sobre src/a.js (sua edição #1):');
  });

  it('calls a command change by its name', () => {
    expect(commentHeader(edit({ seq: 3, status: 'by-command' }))).toBe(
      'Sobre src/a.js, linhas 14–18 (mudança por comando #3):',
    );
  });
});

describe('buildCommentMessage', () => {
  it('keeps the comment lines under the header', () => {
    expect(buildCommentMessage(edit(), 'troca isso\npor aquilo')).toBe(
      'Sobre src/a.js, linhas 14–18 (sua edição #1):\ntroca isso\npor aquilo',
    );
  });
});

describe('validateComment', () => {
  it('trims and refuses empty or oversized comments', () => {
    expect(validateComment('  oi  ')).toEqual({ ok: true, text: 'oi' });
    expect(validateComment('   ')).toEqual({ ok: false, error: 'Escreve alguma coisa' });
    expect(validateComment('x'.repeat(MAX_COMMENT_CHARS + 1))).toEqual({
      ok: false,
      error: 'Comentário longo demais (máx. 4000)',
    });
  });
});

describe('channel encodings', () => {
  it('wraps a paste so a multi-line comment is one message', () => {
    expect(bracketedPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });

  it('flattens for typing, where a newline would send half', () => {
    expect(flattenForTyping('a\n  b')).toBe('a b');
  });
});
