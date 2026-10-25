import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCustomTitleScanner, parseConversationTitle, readConversationTitle } from '../src/main/transcript.js';
import { listConversations, resolveClaudeProjectDir } from '../src/main/conversations.js';
import { claudeProjectDir } from '../src/main/cc-sessions.js';

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

describe('resolveClaudeProjectDir (#157)', () => {
  const home = '/h';
  const projects = path.join(home, '.claude', 'projects');
  const longCwd = `/h/${'nome-bem-comprido/'.repeat(14)}fim`;
  const prefix = `${longCwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-`;
  const ID = '11111111-1111-1111-1111-111111111111';
  const fakeFs = (tree, heads = {}) => ({
    readdir: async (dir) => {
      if (!(dir in tree)) throw new Error('ENOENT');
      return tree[dir];
    },
    readHead: async (file) => heads[file] ?? '',
    home,
  });

  it('a short path is the flattened name, no scan', async () => {
    const deps = fakeFs({});
    expect(await resolveClaudeProjectDir('/h/vizor', deps)).toBe(path.join(projects, '-h-vizor'));
  });

  it('a long path whose exact name exists is that folder', async () => {
    const exact = claudeProjectDir(longCwd, { home });
    const deps = fakeFs({ [projects]: [path.basename(exact)] });
    expect(await resolveClaudeProjectDir(longCwd, deps)).toBe(exact);
  });

  it('a long path hashed by another Claude Code build: the folder whose chats ran in that cwd', async () => {
    const other = `${prefix}outrohash`;
    const mine = `${prefix}abc123`;
    const deps = fakeFs(
      {
        [projects]: ['-h-vizor', other, mine],
        [path.join(projects, other)]: [`${ID}.jsonl`],
        [path.join(projects, mine)]: ['notes.txt', `${ID}.jsonl`],
      },
      {
        [path.join(projects, other, `${ID}.jsonl`)]: `${JSON.stringify({ type: 'user', cwd: `${longCwd}-irma` })}\n`,
        [path.join(projects, mine, `${ID}.jsonl`)]: `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({
          type: 'user',
          cwd: longCwd,
        })}\n`,
      },
    );
    expect(await resolveClaudeProjectDir(longCwd, deps)).toBe(path.join(projects, mine));
  });

  it('nothing that proves it: the computed name (lists nothing, as before)', async () => {
    const deps = fakeFs({ [projects]: [`${prefix}x`], [path.join(projects, `${prefix}x`)]: [] });
    expect(await resolveClaudeProjectDir(longCwd, deps)).toBe(claudeProjectDir(longCwd, { home }));
  });
});

describe('createCustomTitleScanner (#157 review)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-scan-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filler = (count, size = 500) =>
    Array.from({ length: count }, (_, index) => line({ type: 'user', message: { content: `${index} ${'x'.repeat(size)}` } }));
  const write = (name, lines) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };
  // Records every read and how many handles are open at once.
  const spyOpen = () => {
    const spy = { reads: [], opens: [], active: 0, maxActive: 0 };
    spy.open = async (file, flags) => {
      const handle = await fs.promises.open(file, flags);
      spy.opens.push(file);
      spy.active += 1;
      spy.maxActive = Math.max(spy.maxActive, spy.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        read: (buffer, offset, length, position) => {
          spy.reads.push({ buffer: buffer.length, length });
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          spy.active -= 1;
          await handle.close();
        },
      };
    };
    return spy;
  };

  it('reads a small append with a buffer the size of the append, not a whole chunk', async () => {
    const spy = spyOpen();
    const scanner = createCustomTitleScanner({ open: spy.open, chunkBytes: 1024 * 1024 });
    const file = write('append.jsonl', [line({ type: 'custom-title', customTitle: 'um' }), ...filler(20)]);
    expect(await scanner.lookup(file)).toBe('um');
    spy.reads.length = 0;
    const extra = `${line({ type: 'custom-title', customTitle: 'dois' })}\n`;
    fs.appendFileSync(file, extra);
    expect(await scanner.lookup(file)).toBe('dois');
    expect(spy.reads).toEqual([{ buffer: Buffer.byteLength(extra), length: Buffer.byteLength(extra) }]);
  });

  it('does not wait on a file past the size limit: it scans in the background for the next open', async () => {
    const scanner = createCustomTitleScanner({ fullScanLimit: 10 * 1024 });
    const file = write('big.jsonl', [line({ type: 'custom-title', customTitle: 'grande' }), ...filler(100)]);
    expect(await scanner.lookup(file)).toBe(null); // the caller falls back to the tail
    await scanner.idle();
    expect(await scanner.lookup(file)).toBe('grande');
  });

  it('starts over when the file at that path was replaced', async () => {
    const scanner = createCustomTitleScanner();
    const file = write('replaced.jsonl', [line({ type: 'custom-title', customTitle: 'antigo' }), ...filler(5)]);
    expect(await scanner.lookup(file)).toBe('antigo');
    const temp = write('replaced.tmp', [...filler(10), line({ type: 'ai-title', aiTitle: 'sem rename' })]);
    fs.renameSync(temp, file);
    expect(await scanner.lookup(file)).toBe(null);
  });

  it('concurrent calls share one scan per file, and at most 2 files are scanned at once', async () => {
    const spy = spyOpen();
    const scanner = createCustomTitleScanner({ open: spy.open, concurrency: 2 });
    const files = Array.from({ length: 5 }, (_, index) =>
      write(`c${index}.jsonl`, [line({ type: 'custom-title', customTitle: `t${index}` }), ...filler(5)]),
    );
    const results = await Promise.all([...files, files[0], files[0]].map((file) => scanner.lookup(file)));
    expect(results).toEqual(['t0', 't1', 't2', 't3', 't4', 't0', 't0']);
    expect(spy.opens.filter((file) => file === files[0])).toHaveLength(1);
    expect(spy.maxActive).toBeLessThanOrEqual(2);
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
