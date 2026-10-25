import { createHash } from 'node:crypto';
import path from 'node:path';

// The project's own names, so a transcript of "abre o pê tê ípsilon róst"
// becomes "abre o pty-host" (#161). Whisper hears pt-BR; the names are code.
// Matching is phonetic and local — no tokens spent.

const LETTERS = {
  a: 'á', b: 'bê', c: 'cê', d: 'dê', e: 'é', f: 'éfe', g: 'gê', h: 'agá', i: 'í', j: 'jota', k: 'cá', l: 'éle', m: 'éme',
  n: 'éne', o: 'ó', p: 'pê', q: 'quê', r: 'érre', s: 'esse', t: 'tê', u: 'u', v: 'vê', w: 'dáblio', x: 'xis', y: 'ípsilon', z: 'zê',
};
const SEPARATOR_WORDS = { '/': ['barra'], '.': ['ponto'], '-': [''], _: [''] };
const MAX_FORMS = 16;
const MAX_FILES = 3000;

// A pt-BR sound key: no accents, word-initial h sounds like r ("róst"),
// y/w/k/q/z folded, other h silent, doubled letters collapsed.
export function phoneticKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(^|[^a-z0-9])h/g, '$1r')
    .replace(/ph/g, 'f')
    .replace(/y/g, 'i')
    .replace(/w/g, 'u')
    .replace(/[kq]/g, 'c')
    .replace(/z/g, 's')
    .replace(/h/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');
}

// "pty", "js", "gh": short and without vowels — said letter by letter.
const spelledOut = (part) => part.length <= 4 && /^[a-z]+$/i.test(part) && !/[aeiou]/i.test(part);

function partForms(part) {
  const forms = [part];
  if (spelledOut(part)) forms.push([...part.toLowerCase()].map((letter) => LETTERS[letter] ?? letter).join(' '));
  return forms;
}

export function spokenForms(term) {
  const text = term.text;
  const pieces = text.split(/([/._-])/).filter(Boolean);
  let forms = [''];
  for (const piece of pieces) {
    const options = SEPARATOR_WORDS[piece] ?? partForms(piece);
    const next = [];
    for (const form of forms) for (const option of options) next.push(`${form} ${option}`);
    forms = next.slice(0, MAX_FORMS);
  }
  const spoken = forms.map((form) => form.replace(/\s+/g, ' ').trim());
  return [...new Set([text, ...spoken, ...(term.spoken ?? [])])];
}

// --- Numbers ---------------------------------------------------------------

const UNITS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19,
};
const TENS = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
const HUNDREDS = {
  cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900,
};
const numberValue = (word) => UNITS[word] ?? TENS[word] ?? HUNDREDS[word];

// "vinte e dois" → 22. A lone "um"/"uma" is an article, not a number.
export function numbersToDigits(text) {
  const tokens = String(text ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index].toLowerCase();
    if (numberValue(word) === undefined) {
      out.push(tokens[index]);
      continue;
    }
    let total = 0;
    let count = 0;
    let cursor = index;
    while (cursor < tokens.length) {
      const value = numberValue(tokens[cursor].toLowerCase());
      if (value === undefined) break;
      total += value;
      count++;
      const link = tokens[cursor + 1]?.toLowerCase();
      if (link === 'e' && numberValue(tokens[cursor + 2]?.toLowerCase()) !== undefined) cursor += 2;
      else {
        cursor += 1;
        break;
      }
    }
    if (count === 1 && (word === 'um' || word === 'uma')) {
      out.push(tokens[index]);
      continue;
    }
    out.push(String(total));
    index = cursor - 1;
  }
  return out.join(' ');
}

// --- Correction ------------------------------------------------------------

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

function candidatesOf(terms, learned) {
  const candidates = [];
  for (const pair of learned) candidates.push({ key: phoneticKey(pair.heard), out: pair.meant, learned: true });
  for (const term of terms) for (const form of spokenForms(term)) candidates.push({ key: phoneticKey(form), out: term.text, learned: false });
  return candidates.filter((candidate) => candidate.key.length >= 3);
}

// Short keys must match exactly: "main" must not eat "manda".
function score(windowKey, candidate) {
  const gap = distance(windowKey, candidate.key) / Math.max(windowKey.length, candidate.key.length);
  if (candidate.learned) return gap <= 0.2 ? gap - 1 : null; // learned pairs first
  if (candidate.key.length < 6) return gap === 0 ? 0 : null;
  return gap <= 0.25 ? gap : null;
}

// A name never starts or ends on a function word: "abre o pt.host" keeps its "o".
const FUNCTION_WORDS = new Set(['o', 'a', 'os', 'as', 'do', 'da', 'dos', 'das', 'de', 'no', 'na', 'nos', 'nas', 'em', 'e', 'um', 'uma', 'pra', 'pro', 'que', 'com', 'por', 'para', 'ao']);
const isFunctionWord = (word) => FUNCTION_WORDS.has(word.toLowerCase().replace(/[^\p{L}]/gu, ''));

export function correctTranscript(text, terms, learned = []) {
  const tokens = numbersToDigits(text).split(/\s+/).filter(Boolean);
  const candidates = candidatesOf(terms, learned);
  const out = [];
  const fixes = [];
  for (let index = 0; index < tokens.length; ) {
    let best = null;
    for (let length = Math.min(4, tokens.length - index); length >= 1; length--) {
      const words = tokens.slice(index, index + length);
      if (isFunctionWord(words[0]) || isFunctionWord(words.at(-1))) continue;
      const windowKey = phoneticKey(words.join(' '));
      if (windowKey.length < 3) continue;
      for (const candidate of candidates) {
        const value = score(windowKey, candidate);
        if (value === null) continue;
        if (!best || value < best.value || (value === best.value && length > best.length))
          best = { value, length, out: candidate.out, from: words.join(' ') };
      }
    }
    if (best && best.from !== best.out) {
      out.push(best.out);
      fixes.push({ from: best.from, to: best.out });
      index += best.length;
    } else if (best) {
      out.push(best.from);
      index += best.length;
    } else {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return { text: out.join(' '), fixes };
}

// --- Scan and storage --------------------------------------------------------

export async function scanVocabulary({ root, run }) {
  const terms = new Map();
  const add = (text, kind, extra = {}) => {
    if (text && text.length >= 3 && !terms.has(text)) terms.set(text, { text, kind, spoken: [], ...extra });
  };
  const tryRun = async (command, args) => {
    try {
      return await run(command, args, { cwd: root });
    } catch {
      return '';
    }
  };
  const files = (await tryRun('git', ['ls-files'])).split('\n').filter(Boolean).slice(0, MAX_FILES);
  for (const file of files) {
    const base = path.basename(file);
    add(base, 'file');
    add(base.replace(/\.[^.]+$/, ''), 'file');
  }
  for (const branch of (await tryRun('git', ['branch', '--format=%(refname:short)'])).split('\n').filter(Boolean)) add(branch, 'branch');
  for (const [kind, args] of [
    ['issue', ['issue', 'list', '--json', 'number,title', '--limit', '100']],
    ['pr', ['pr', 'list', '--json', 'number,title', '--limit', '50']],
  ]) {
    try {
      for (const item of JSON.parse((await tryRun('gh', args)) || '[]')) add(`#${item.number}`, kind, { title: item.title });
    } catch {
      // gh missing or not logged in: names from git are enough
    }
  }
  return { terms: [...terms.values()] };
}

export function createVocabularyStore({ dir, readFile, writeFile, rename }) {
  const fileOf = (root) => path.join(dir, `${createHash('sha1').update(root).digest('hex')}.json`);
  const empty = () => ({ terms: [], learned: [], scannedAt: 0 });
  const load = (root) => {
    try {
      return { ...empty(), ...JSON.parse(readFile(fileOf(root))) };
    } catch {
      return empty();
    }
  };
  const write = (root, data) => {
    const file = fileOf(root);
    writeFile(`${file}.tmp`, JSON.stringify(data));
    rename(`${file}.tmp`, file);
  };
  return {
    load,
    save: (root, { terms, scannedAt }) => write(root, { ...load(root), terms, scannedAt }),
    learn: (root, pair) => {
      const data = load(root);
      const learned = [...data.learned.filter((item) => phoneticKey(item.heard) !== phoneticKey(pair.heard)), pair];
      write(root, { ...data, learned });
    },
  };
}

// The part of what was heard that the user just corrected: "roda os testes
// do rubik guard" + "não, é rule-guard" → "rubik guard".
export function closestPhrase(text, meant) {
  const target = phoneticKey(meant);
  const tokens = String(text ?? '').split(/\s+/).filter(Boolean);
  let best = null;
  for (let index = 0; index < tokens.length; index++) {
    for (let length = 1; length <= 4 && index + length <= tokens.length; length++) {
      const words = tokens.slice(index, index + length);
      if (isFunctionWord(words[0]) || isFunctionWord(words.at(-1))) continue;
      const key = phoneticKey(words.join(' '));
      if (key.length < 3) continue;
      const gap = distance(key, target) / Math.max(key.length, target.length);
      if (!best || gap < best.gap) best = { gap, phrase: words.join(' ') };
    }
  }
  return best && best.gap <= 0.6 ? best.phrase.replace(/[?!.,;:…]+$/, '') : null;
}
