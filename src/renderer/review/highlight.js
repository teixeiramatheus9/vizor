// A small JS/TS highlighter, one line at a time: no parser, just enough to
// colour keywords, strings, comments and numbers in a diff. The state carries
// what can cross a line break (block comment, template string, `${}` depth).
import { escapeHtml } from '../workspace-view.js';

const KEYWORDS = new Set(('const let var function return if else for while do switch case break continue new class extends '
  + 'import export from default async await try catch finally throw typeof instanceof in of interface type enum implements '
  + 'public private protected readonly as satisfies null undefined true false this super yield void delete').split(' '));

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUM_PART = /[0-9A-Za-z_.]/;

// state: { block, tpl, braces } — braces is the stack of open `{` counts for
// each `${` we are inside of (so a template can nest code that has braces).
export const initialState = () => ({ block: false, tpl: false, braces: [] });

export function tokenizeLine(text, state) {
  let { block, tpl } = state ?? initialState();
  const braces = [...(state?.braces ?? [])];
  const tokens = [];
  const push = (type, value) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += value;
    else tokens.push({ type, text: value });
  };
  let i = 0;
  const n = text.length;

  // Reads template text from i up to the closing backtick or a `${`.
  const readTemplate = () => {
    let j = i;
    while (j < n) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { push('str', text.slice(i, j + 1)); i = j + 1; tpl = false; return; }
      if (c === '$' && text[j + 1] === '{') {
        push('str', text.slice(i, j + 2));
        i = j + 2; tpl = false; braces.push(0); return;
      }
      j++;
    }
    push('str', text.slice(i));
    i = n;
  };

  while (i < n) {
    if (block) {
      const end = text.indexOf('*/', i);
      if (end === -1) { push('com', text.slice(i)); i = n; } else { push('com', text.slice(i, end + 2)); i = end + 2; block = false; }
      continue;
    }
    if (tpl) { readTemplate(); continue; }
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { push('com', text.slice(i)); i = n; continue; }
    if (c === '/' && text[i + 1] === '*') { block = true; push('com', '/*'); i += 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      push('str', text.slice(i, Math.min(j + 1, n)));
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '`') { push('str', '`'); i++; tpl = true; continue; }
    if (braces.length && c === '{') { braces[braces.length - 1]++; push('plain', c); i++; continue; }
    if (braces.length && c === '}') {
      if (braces[braces.length - 1] === 0) { braces.pop(); push('str', '}'); i++; tpl = true; continue; }
      braces[braces.length - 1]--; push('plain', c); i++; continue;
    }
    if (/[0-9]/.test(c) && !(i > 0 && IDENT_PART.test(text[i - 1]))) {
      let j = i + 1;
      while (j < n && NUM_PART.test(text[j])) j++;
      push('num', text.slice(i, j));
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(text[j])) j++;
      const word = text.slice(i, j);
      // `obj.type` is a property, not the keyword.
      push(KEYWORDS.has(word) && text[i - 1] !== '.' ? 'kw' : 'plain', word);
      i = j;
      continue;
    }
    push('plain', c);
    i++;
  }
  return { tokens, state: { block, tpl, braces } };
}

export function highlightLine(text, state) {
  const { tokens, state: next } = tokenizeLine(text, state);
  const html = tokens.map((t) => (t.type === 'plain' ? escapeHtml(t.text) : `<span class="tok-${t.type}">${escapeHtml(t.text)}</span>`)).join('');
  return { html, state: next };
}
