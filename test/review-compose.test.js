import { describe, it, expect } from 'vitest';
import { composeMessage, EXPLAIN_TEXT, rejectNotice } from '../src/main/review/compose.js';

describe('composeMessage', () => {
  it('prefixes a hunk with its path and new-side lines', () => {
    expect(composeMessage({ kind: 'hunk', path: 'a.js', newStart: 10, newLines: 4 }, ' por quê? ').message)
      .toBe('Sobre a.js, linhas 10–13 (trecho da revisão):\npor quê?');
  });
  it('says "linha" for one line and "perto da linha" for a deletion', () => {
    expect(composeMessage({ kind: 'hunk', path: 'a.js', newStart: 7, newLines: 1 }, 'x').message).toBe('Sobre a.js, linha 7 (trecho da revisão):\nx');
    expect(composeMessage({ kind: 'hunk', path: 'a.js', newStart: 7, newLines: 0 }, 'x').message).toBe('Sobre a.js, perto da linha 7 (trecho da revisão):\nx');
  });
  it('prefixes a file', () => {
    expect(composeMessage({ kind: 'file', path: 'src/b.js' }, 'oi').message).toBe('Sobre src/b.js (arquivo da revisão):\noi');
  });
  it('prefixes a graph node, with or without lines', () => {
    expect(composeMessage({ kind: 'node', label: 'run', path: 'c.js', startLine: 3, endLine: 9 }, 'oi').message).toBe('Sobre run (c.js, linhas 3–9, grafo da revisão):\noi');
    expect(composeMessage({ kind: 'node', label: 'run', path: 'c.js' }, 'oi').message).toBe('Sobre run (c.js, grafo da revisão):\noi');
  });
  it('sends just the text without a context', () => {
    expect(composeMessage(null, ' oi ').message).toBe('oi');
  });
  it('validates the text', () => {
    expect(composeMessage(null, '  ').ok).toBe(false);
    expect(composeMessage(null, 'x'.repeat(4001)).ok).toBe(false);
  });
  it('has the fixed texts', () => {
    expect(EXPLAIN_TEXT).toBe('Explique esse trecho e por que foi feito assim.');
    expect(rejectNotice('a.js', 12)).toBe('Desfiz o trecho de a.js perto da linha 12, na revisão. Não refaça sem me perguntar.');
  });
});
