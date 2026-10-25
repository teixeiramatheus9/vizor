import { describe, it, expect } from 'vitest';
import { analyzeReply, createReplyCursor, spokenReply } from '../src/main/voice/replies.js';

const LIST = `Tem três boas opções pra hash de senha:

- **argon2id**: o mais moderno, resistente a GPU.
- **bcrypt**: maduro, em todo lugar.
- **scrypt**: bom, mas menos usado.

Recomendo argon2id.`;

describe('analyzeReply', () => {
  it('strips markdown and finds a top-level list', () => {
    const analysis = analyzeReply(LIST);
    expect(analysis.items).toEqual(['argon2id: o mais moderno, resistente a GPU.', 'bcrypt: maduro, em todo lugar.', 'scrypt: bom, mas menos usado.']);
    expect(analysis.plain).not.toMatch(/\*\*/);
    expect(analysis.hasCode).toBe(false);
  });

  it('drops code blocks and says there was code', () => {
    const analysis = analyzeReply('Feito. Troquei assim:\n\n```js\nconst x = 1;\n```\n\nPronto.');
    expect(analysis.plain).not.toContain('const');
    expect(analysis.hasCode).toBe(true);
  });
});

describe('spokenReply', () => {
  const never = async () => {
    throw new Error('should not summarize');
  };

  it('a short answer is read as it is, without markdown', async () => {
    const reply = await spokenReply(analyzeReply('Pronto, **troquei** o `bcrypt` pelo argon2id.'), { summarize: never });
    expect(reply).toEqual({ speech: 'Pronto, troquei o bcrypt pelo argon2id.', navigable: false });
  });

  it('a list becomes its labels, the recommendation and an offer', async () => {
    const reply = await spokenReply(analyzeReply(LIST), { summarize: never });
    expect(reply.speech).toBe('três opções: argon2id, bcrypt e scrypt. Recomendo argon2id. Quer que eu leia os tópicos?');
    expect(reply.navigable).toBe(true);
  });

  it('never reads code aloud', async () => {
    const reply = await spokenReply(analyzeReply('Feito.\n\n```js\nconst x = 1;\n```'), { summarize: never });
    expect(reply.speech).toBe('Feito. Tem código na tela.');
  });

  it('a long answer is summarized once; in economy mode it is not', async () => {
    const long = 'Explicação longa. '.repeat(30);
    let calls = 0;
    const summarize = async () => (calls++, 'Resumo em duas frases.');
    expect((await spokenReply(analyzeReply(long), { summarize })).speech).toBe('Resumo em duas frases.');
    expect(calls).toBe(1);
    expect((await spokenReply(analyzeReply(long), { summarize: never, economy: true })).speech).toBe('Terminei, a resposta tá na tela.');
  });

  it('a summarizer failure falls back to the screen', async () => {
    const reply = await spokenReply(analyzeReply('x '.repeat(400)), { summarize: async () => null });
    expect(reply.speech).toBe('Terminei, a resposta tá na tela.');
  });

  it('never says its own name', async () => {
    const reply = await spokenReply(analyzeReply('O Vizor já abriu o arquivo.'), { summarize: never });
    expect(reply.speech).not.toMatch(/vizor/i);
  });
});

describe('createReplyCursor', () => {
  it('walks the items and stops at the end', () => {
    const cursor = createReplyCursor(['argon2id: moderno.', 'bcrypt: maduro.']);
    expect(cursor.topics()).toBe('Primeiro: argon2id: moderno.');
    expect(cursor.next()).toBe('Segundo: bcrypt: maduro.');
    expect(cursor.next()).toBe('Acabaram os tópicos.');
    expect(cursor.previous()).toBe('Primeiro: argon2id: moderno.');
    expect(cursor.repeat()).toBe('Primeiro: argon2id: moderno.');
    expect(cursor.detail(2)).toBe('Segundo: bcrypt: maduro.');
    expect(cursor.detail(5)).toBe('Só tem 2 tópicos.');
  });
});

describe('in English, for an English voice', () => {
  const summarize = async () => 'Argon2id is the pick.';

  it('a list: count, labels, the recommendation and the offer', async () => {
    const english = `Three options:\n\n- **argon2id**: newest.\n- **bcrypt**: mature.\n- **scrypt**: fine.\n\nI recommend argon2id.`;
    const reply = await spokenReply(analyzeReply(english), { summarize, lang: 'en' });
    expect(reply.speech).toBe('three options: argon2id, bcrypt and scrypt. I recommend argon2id. Want me to read the topics?');
    // A Portuguese recommendation is not read with the English voice.
    expect((await spokenReply(analyzeReply(LIST), { summarize, lang: 'en' })).speech).toBe('three options: argon2id, bcrypt and scrypt. Want me to read the topics?');
  });

  it('a short Portuguese answer goes through the summarizer, which speaks English', async () => {
    const reply = await spokenReply(analyzeReply('Feito, o teste passou.'), { summarize, lang: 'en' });
    expect(reply.speech).toBe('Argon2id is the pick.');
  });

  it('economy mode or a failing summarizer: the answer is on screen', async () => {
    expect((await spokenReply(analyzeReply('Feito.'), { summarize, lang: 'en', economy: true })).speech).toBe('Done, the answer is on screen.');
    const failing = async () => { throw new Error('x'); };
    expect((await spokenReply(analyzeReply('Feito.'), { summarize: failing, lang: 'en' })).speech).toBe('Done, the answer is on screen.');
  });

  it('code on screen, and the topics walked in English', async () => {
    const reply = await spokenReply(analyzeReply('Pronto:\n```js\nx()\n```'), { summarize, lang: 'en' });
    expect(reply.speech).toBe("Argon2id is the pick. There's code on screen.");
    const cursor = createReplyCursor(['a', 'b'], 'en');
    expect(cursor.topics()).toBe('First: a');
    expect(cursor.next()).toBe('Second: b');
    expect(cursor.next()).toBe("That's all the topics.");
    expect(cursor.detail(5)).toBe('There are only 2 topics.');
  });
});
