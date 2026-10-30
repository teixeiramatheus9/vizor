import { describe, expect, it } from 'vitest';
import { highlightLine, tokenizeLine } from '../src/renderer/review/highlight.js';

const types = (text, state) => tokenizeLine(text, state).tokens.map((t) => [t.type, t.text]);

describe('the review highlighter', () => {
  it('marks keywords, not properties named like them', () => {
    expect(types('const x = a.type')).toEqual([['kw', 'const'], ['plain', ' x = a.type']]);
  });
  it('keeps escaped quotes inside the string', () => {
    expect(types(`x = "a\\"b" + 1`)).toEqual([['plain', 'x = '], ['str', '"a\\"b"'], ['plain', ' + '], ['num', '1']]);
  });
  it('line comment runs to the end', () => {
    expect(types('a // const b')).toEqual([['plain', 'a '], ['com', '// const b']]);
  });
  it('block comment crosses three lines through the state', () => {
    const a = tokenizeLine('x /* one', undefined);
    const b = tokenizeLine('const two', a.state);
    const c = tokenizeLine('end */ const', b.state);
    expect(b.tokens).toEqual([{ type: 'com', text: 'const two' }]);
    expect(c.tokens.map((t) => t.type)).toEqual(['com', 'plain', 'kw']);
    expect(c.state.block).toBe(false);
  });
  it('template string with ${} switches to code and back, across lines', () => {
    const a = tokenizeLine('s = `a ${ const {b} } c', undefined);
    expect(a.tokens.map((t) => t.type)).toEqual(['plain', 'str', 'plain', 'kw', 'plain', 'str']);
    expect(a.state.tpl).toBe(true);
    const b = tokenizeLine('more` + 1', a.state);
    expect(b.tokens.map((t) => t.type)).toEqual(['str', 'plain', 'num']);
    expect(b.state.tpl).toBe(false);
  });
  it('escapes markup in code', () => {
    const { html } = highlightLine('<script>alert("x")</script>', undefined);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
