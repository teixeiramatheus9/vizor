import { describe, it, expect } from 'vitest';
import {
  correctTranscript,
  createVocabularyStore,
  numbersToDigits,
  phoneticKey,
  scanVocabulary,
  spokenForms,
} from '../src/main/voice/vocabulary.js';

const term = (text, kind = 'file') => ({ text, kind, spoken: [] });
const TERMS = [
  term('pty-host'),
  term('pty-host.js'),
  term('rule-guard'),
  term('rule-guard.js'),
  term('feat/regras-trava', 'branch'),
  term('index.js'),
  term('main', 'branch'),
];

describe('phoneticKey', () => {
  it('folds accents, h-as-r, y, doubles and punctuation', () => {
    expect(phoneticKey('Róst')).toBe(phoneticKey('host'));
    expect(phoneticKey('pty')).toBe(phoneticKey('pti'));
    expect(phoneticKey('a  B.c')).toBe('abc');
  });
});

describe('spokenForms', () => {
  it('spells short consonant clusters as letters and names the separators', () => {
    const forms = spokenForms(term('pty-host.js'));
    expect(forms).toContain('pê tê ípsilon host ponto jota esse');
    expect(forms).toContain('pty-host.js');
    expect(spokenForms(term('feat/regras-trava'))).toContain('feat barra regras trava');
  });
});

describe('numbersToDigits', () => {
  it('turns spoken pt-BR numbers into digits', () => {
    expect(numbersToDigits('retoma a task vinte e dois')).toBe('retoma a task 22');
    expect(numbersToDigits('abre a issue cento e sessenta e um')).toBe('abre a issue 161');
    expect(numbersToDigits('volta pra PR doze')).toBe('volta pra PR 12');
    expect(numbersToDigits('e então um arquivo')).toBe('e então um arquivo');
  });
});

describe('correctTranscript', () => {
  it('fixes what the spike heard', () => {
    expect(correctTranscript('abre o pê tê ípsilon róst', TERMS).text).toBe('abre o pty-host');
    expect(correctTranscript('Abre o pt.host.js', TERMS).text).toBe('Abre o pty-host.js');
    expect(correctTranscript('roda os testes do rule guard', TERMS).text).toBe('roda os testes do rule-guard');
    expect(correctTranscript('faz o rebase na feat barra regras trava', TERMS).text).toBe('faz o rebase na feat/regras-trava');
    expect(correctTranscript('retoma a task vinte e dois', TERMS).text).toBe('retoma a task 22');
    // The user's real voice through Whisper base: too far to guess ("feat"
    // is said "fít") — never a half replacement; learning covers it.
    expect(correctTranscript('faz o rebase na fute bar, regras, trav...', TERMS).text).toBe('faz o rebase na fute bar, regras, trav...');
    const learned = [{ heard: 'fute bar regras trav', meant: 'feat/regras-trava' }];
    expect(correctTranscript('faz o rebase na fute bar, regras, trav...', TERMS, learned).text).toBe('faz o rebase na feat/regras-trava');
  });

  it('leaves ordinary Portuguese alone', () => {
    for (const phrase of ['então abre a porta', 'mostra o índice da página', 'o que temos pra hoje', 'manda ver'])
      expect(correctTranscript(phrase, TERMS).text).toBe(phrase);
  });

  it('a learned pronunciation wins and is reported', () => {
    const learned = [{ heard: 'rubik guard', meant: 'rule-guard' }];
    const result = correctTranscript('roda os testes do Rubik guard', TERMS, learned);
    expect(result.text).toBe('roda os testes do rule-guard');
    expect(result.fixes).toEqual([{ from: 'Rubik guard', to: 'rule-guard' }]);
  });
});

describe('scanVocabulary', () => {
  it('collects files, branches, issues and PRs, and survives gh failing', async () => {
    const run = async (command, args) => {
      if (command === 'git' && args[0] === 'ls-files') return 'src/main/pty-host.js\nsrc/hook/rule-guard.js\nREADME.md\n';
      if (command === 'git' && args[0] === 'branch') return 'main\nfeat/regras-trava\n';
      if (command === 'gh' && args[1] === 'list' && args[0] === 'issue') return JSON.stringify([{ number: 161, title: 'Modo voz 2/4' }]);
      throw new Error('gh: not logged in');
    };
    const { terms } = await scanVocabulary({ root: '/r', run });
    const texts = terms.map((item) => item.text);
    expect(texts).toEqual(expect.arrayContaining(['pty-host.js', 'pty-host', 'rule-guard', 'feat/regras-trava', '#161']));
    expect(terms.find((item) => item.text === '#161')).toMatchObject({ kind: 'issue' });
  });
});

describe('vocabulary store', () => {
  it('keeps terms and learned pairs per project, atomically', () => {
    const files = {};
    const store = createVocabularyStore({
      dir: '/v',
      readFile: (file) => {
        if (!(file in files)) throw new Error('ENOENT');
        return files[file];
      },
      writeFile: (file, content) => (files[file] = content),
      rename: (from, to) => {
        files[to] = files[from];
        delete files[from];
      },
    });
    store.save('/r', { terms: [term('x-y')], scannedAt: 1 });
    store.learn('/r', { heard: 'rubik guard', meant: 'rule-guard' });
    expect(store.load('/r')).toMatchObject({ terms: [{ text: 'x-y' }], learned: [{ heard: 'rubik guard', meant: 'rule-guard' }] });
    expect(store.load('/other')).toEqual({ terms: [], learned: [], scannedAt: 0 });
    store.unlearn('/r', 'rubik guard');
    expect(store.load('/r').learned).toEqual([]);
    expect(Object.keys(files).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('correction cost (review I10)', () => {
  it('a long dictation over a big repo stays cheap with prebuilt candidates', async () => {
    const { buildCandidates } = await import('../src/main/voice/vocabulary.js');
    const terms = Array.from({ length: 6000 }, (_, n) => ({ text: `modulo-${n}-servico.js`, kind: 'file', spoken: [] }));
    terms.push({ text: 'pty-host.js', kind: 'file', spoken: [] });
    const candidates = buildCandidates(terms, []);
    const phrase = `${'então a gente precisa ajustar isso aqui com calma '.repeat(5)} abre o pt.host.js`;
    const started = performance.now();
    const result = correctTranscript(phrase, terms, [], candidates);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.text.endsWith('abre o pty-host.js')).toBe(true);
  });
});
