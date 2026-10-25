import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationTitle, readConversationTitle } from '../src/main/transcript.js';
import { listConversations } from '../src/main/conversations.js';

const line = (entry) => JSON.stringify(entry);

describe('parseConversationTitle', () => {
  it('prefers the name the user gave, then Claude\'s title, then the last prompt', () => {
    const base = [
      line({ type: 'last-prompt', lastPrompt: 'bora na leva A' }),
      line({ type: 'ai-title', aiTitle: 'Vizor IDE' }),
    ];
    expect(parseConversationTitle([...base, line({ type: 'custom-title', customTitle: 'workspace' })].join('\n'))).toBe(
      'workspace',
    );
    expect(parseConversationTitle(base.join('\n'))).toBe('Vizor IDE');
    expect(parseConversationTitle(base[0])).toBe('bora na leva A');
  });

  it('reads the latest of each and skips broken lines', () => {
    const text = [
      line({ type: 'ai-title', aiTitle: 'velho' }),
      '{broken',
      line({ type: 'ai-title', aiTitle: 'novo' }),
    ].join('\n');
    expect(parseConversationTitle(text)).toBe('novo');
    expect(parseConversationTitle('')).toBe(null);
  });
});

describe('readConversationTitle on a long chat (#157)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-title-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  // ~600 KB of chat: well past the tail the menu reads.
  const filler = Array.from({ length: 300 }, (_, index) =>
    line({ type: 'user', message: { role: 'user', content: `${index} ${'x'.repeat(2000)}` } }),
  );

  it('finds a /rename made at the start of the chat', async () => {
    const file = path.join(dir, 'start.jsonl');
    fs.writeFileSync(
      file,
      [line({ type: 'custom-title', customTitle: 'meu nome' }), ...filler, line({ type: 'ai-title', aiTitle: 'IA' })].join(
        '\n',
      ) + '\n',
    );
    expect(await readConversationTitle(file)).toBe('meu nome');
  });

  it('keeps the latest rename, also one appended after the first read', async () => {
    const file = path.join(dir, 'later.jsonl');
    fs.writeFileSync(file, [line({ type: 'custom-title', customTitle: 'primeiro' }), ...filler].join('\n') + '\n');
    expect(await readConversationTitle(file)).toBe('primeiro');
    fs.appendFileSync(file, [...filler, line({ type: 'custom-title', customTitle: 'segundo' }), ...filler].join('\n') + '\n');
    expect(await readConversationTitle(file)).toBe('segundo');
  });

  it('is not fooled by a message that only mentions custom-title', async () => {
    const file = path.join(dir, 'mention.jsonl');
    const mention = line({
      type: 'user',
      message: { content: JSON.stringify({ type: 'custom-title', customTitle: 'falso' }) + 'y'.repeat(70000) },
    });
    fs.writeFileSync(file, [mention, ...filler, line({ type: 'ai-title', aiTitle: 'IA' })].join('\n') + '\n');
    expect(await readConversationTitle(file)).toBe('IA');
  });
});

describe('listConversations', () => {
  const ID1 = '11111111-1111-1111-1111-111111111111';
  const ID2 = '22222222-2222-2222-2222-222222222222';
  const ID3 = '33333333-3333-3333-3333-333333333333';
  const files = {
    [`${ID1}.jsonl`]: { mtimeMs: 100, size: 10, title: 'antiga' },
    [`${ID2}.jsonl`]: { mtimeMs: 300, size: 10, title: null },
    [`${ID3}.jsonl`]: { mtimeMs: 200, size: 0, title: 'vazia' },
    'notes.txt': { mtimeMs: 400, size: 10 },
    'abc.jsonl': { mtimeMs: 500, size: 10, title: 'não é sessão' },
  };
  const deps = {
    readdir: async () => Object.keys(files),
    stat: async (file) => files[file.split('/').pop()],
    readTitle: async (file) => files[file.split('/').pop()].title,
  };

  it('lists the chats of a folder newest first, skipping empty and foreign files', async () => {
    expect(await listConversations('/p', deps)).toEqual([
      { sessionId: ID2, title: null, updatedAt: 300 },
      { sessionId: ID1, title: 'antiga', updatedAt: 100 },
    ]);
  });

  it('caps the list', async () => {
    expect(await listConversations('/p', { ...deps, limit: 1 })).toHaveLength(1);
  });

  it('a folder with no chats yet gives an empty list', async () => {
    expect(
      await listConversations('/p', {
        ...deps,
        readdir: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual([]);
  });
});
