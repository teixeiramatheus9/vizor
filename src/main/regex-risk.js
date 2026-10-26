// The guard runs approved regexes synchronously on every guarded call, and
// JavaScript has no match timeout: a catastrophic pattern would hang the hook
// (and Claude Code with it) until its 600 s timeout (#165). Exponential
// backtracking needs a repetition whose body can match the same text in more
// than one way, so a repeated group is refused when:
// - its alternatives can start with the same character — (.|\s)*, (a|ab)+;
// - its body repeats something and does not start with a "delimiter": a
//   mandatory run (\s+, -) closed by a mandatory piece it cannot match, with
//   nothing variable after it able to eat the next delimiter. That keeps the
//   usual flag shapes — (\s+-\w+)*, (\s+\S+)*, (\s+--?\w+(=\S+)?)* — and
//   refuses (a+)+, (\w+\s?)*, (.*x){12}.
// Polynomial blowups (.*.*.*x on a huge command) are not covered.
const MAX_PATTERN_CHARS = 500;

export const RISK_TOO_LONG = `longa demais (mais de ${MAX_PATTERN_CHARS} caracteres)`;
export const RISK_NESTED = 'repetição dentro de repetição, que pode travar a checagem';
export const RISK_OVERLAP = 'alternativas que se sobrepõem dentro de uma repetição';

// Characters the sets are compared on: Latin-1 plus a few that \s, \w and .
// treat differently.
const SAMPLES = [...Array.from({ length: 256 }, (_, code) => String.fromCharCode(code)), 'é', 'ç', '中', ' ', ' ', '　'];
const ALL = SAMPLES.map(() => true);

function charSet(src) {
  if (src === null) return ALL;
  try {
    const regex = new RegExp(`^(?:${src})$`, 'i');
    return SAMPLES.map((char) => regex.test(char));
  } catch {
    return ALL;
  }
}

const overlaps = (a, b) => a.some((value, index) => value && b[index]);
const union = (sets) => SAMPLES.map((_, index) => sets.some((set) => set[index]));

function quantifierAt(text, index) {
  const char = text[index];
  let length = 0;
  let min = 1;
  let max = 1;
  if (char === '*') [length, min, max] = [1, 0, Infinity];
  else if (char === '+') [length, min, max] = [1, 1, Infinity];
  else if (char === '?') [length, min, max] = [1, 0, 1];
  else if (char === '{') {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(text.slice(index));
    if (braces) {
      const [whole, low, comma, high] = braces;
      length = whole.length;
      min = Number(low);
      max = comma ? (high === '' ? Infinity : Number(high)) : min;
    }
  }
  if (length && text[index + length] === '?') length += 1; // lazy
  return { length, min, max };
}

// Nodes: { type: 'atom', src, min, max } (src null = unknown, a backreference)
// and { type: 'group', alts: [[node]], lookaround, min, max }. Anchors are
// dropped: they match no character.
function parse(text) {
  let index = 0;
  const skipPast = (char) => {
    const close = text.indexOf(char, index);
    index = close === -1 ? text.length : close + 1;
  };

  function alternatives() {
    const alts = [[]];
    while (index < text.length && text[index] !== ')') {
      if (text[index] === '|') {
        alts.push([]);
        index++;
        continue;
      }
      const node = piece();
      if (node) alts[alts.length - 1].push(node);
    }
    return alts;
  }

  function piece() {
    const start = index;
    const char = text[index];
    let node = null;
    if (char === '(') {
      index++;
      let lookaround = false;
      if (text[index] === '?') {
        const next = text[index + 1];
        if (next === ':') index += 2;
        else if (next === '=' || next === '!') [index, lookaround] = [index + 2, true];
        else if (next === '<' && (text[index + 2] === '=' || text[index + 2] === '!')) [index, lookaround] = [index + 3, true];
        else if (next === '<') skipPast('>');
        else index += 1;
      }
      const alts = alternatives();
      index++; // ')'
      node = { type: 'group', alts, lookaround };
    } else if (char === '[') {
      let end = index + 1;
      if (text[end] === '^') end++;
      if (text[end] === ']') end++;
      while (end < text.length && text[end] !== ']') end += text[end] === '\\' ? 2 : 1;
      index = end + 1;
      node = { type: 'atom', src: text.slice(start, index) };
    } else if (char === '\\') {
      const next = text[index + 1];
      if (next === 'b' || next === 'B') index += 2;
      else if (/[1-9]/.test(next ?? '')) {
        index += 1;
        while (/\d/.test(text[index] ?? '')) index++;
        node = { type: 'atom', src: null };
      } else if (next === 'k' && text[index + 2] === '<') {
        skipPast('>');
        node = { type: 'atom', src: null };
      } else {
        if (next === 'x') index += 4;
        else if (next === 'u') index += text[index + 2] === '{' ? 0 : 6;
        else if (next === 'c') index += 3;
        else index += 2;
        if ((next === 'u' && text[start + 2] === '{') || ((next === 'p' || next === 'P') && text[start + 2] === '{')) skipPast('}');
        node = { type: 'atom', src: text.slice(start, index) };
      }
    } else if (char === '^' || char === '$') {
      index++;
    } else {
      index++;
      node = { type: 'atom', src: char };
    }
    const quantifier = quantifierAt(text, index);
    index += quantifier.length;
    if (!node) return null;
    return { ...node, min: quantifier.min, max: quantifier.max };
  }

  return alternatives();
}

const sequence = (alt) => alt.filter((node) => !(node.type === 'group' && node.lookaround));
const repeatsInside = (node) =>
  node.max > 1 || (node.type === 'group' && node.alts.some((alt) => alt.some(repeatsInside)));

function firstSet(node) {
  if (node.type === 'atom') return charSet(node.src);
  const firsts = node.alts.map((alt) => {
    const [head] = sequence(alt);
    return head && head.min >= 1 ? firstSet(head) : ALL;
  });
  return union(firsts);
}

// Sets of the atoms that can take a variable number of characters.
function variableSets(nodes, inVariable = false) {
  const sets = [];
  for (const node of nodes) {
    const variable = inVariable || node.min !== node.max;
    if (node.type === 'atom') {
      if (variable) sets.push(charSet(node.src));
    } else {
      for (const alt of node.alts) sets.push(...variableSets(sequence(alt), variable));
    }
  }
  return sets;
}

function repeatedGroupRisk(group) {
  const alts = group.alts.map(sequence);
  const firsts = alts.map((alt) => (alt[0] && alt[0].min >= 1 ? firstSet(alt[0]) : ALL));
  for (let a = 0; a < firsts.length; a++)
    for (let b = a + 1; b < firsts.length; b++) if (overlaps(firsts[a], firsts[b])) return RISK_OVERLAP;
  const starts = union(firsts);
  for (const alt of alts) {
    if (!alt.some(repeatsInside)) continue;
    const [head, next] = alt;
    if (head?.type !== 'atom' || head.min < 1) return RISK_NESTED;
    const delimiter = charSet(head.src);
    if (!next || next.min < 1 || overlaps(firstSet(next), delimiter)) return RISK_NESTED;
    if (variableSets(alt.slice(1)).some((set) => overlaps(set, starts))) return RISK_NESTED;
  }
  return null;
}

function risk(alts) {
  for (const alt of alts) {
    for (const node of alt) {
      if (node.type !== 'group') continue;
      const inner = risk(node.alts);
      if (inner) return inner;
      if (node.max > 1 && !node.lookaround) {
        const own = repeatedGroupRisk(node);
        if (own) return own;
      }
    }
  }
  return null;
}

// null = fine; otherwise the reason, in pt-BR, for the rules window.
export function regexRisk(pattern) {
  const text = String(pattern);
  if (text.length > MAX_PATTERN_CHARS) return RISK_TOO_LONG;
  return risk(parse(text));
}
