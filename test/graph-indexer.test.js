import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';
import { createGraphIndexer, createWorkerParser } from '../src/main/graph/indexer.js';

// A fake project: files with content and mtime; parse counts its calls.
function project(initial) {
  const files = new Map(Object.entries(initial).map(([relPath, source]) => [relPath, { source, mtimeMs: 1 }]));
  const parsed = [];
  const indexer = createGraphIndexer({
    root: '/p',
    listFiles: async () => [...files.keys()],
    statFile: async (relPath) => ({ mtimeMs: files.get(relPath).mtimeMs, size: files.get(relPath).source.length }),
    readFile: async (relPath) => files.get(relPath).source,
    parse: async (source, relPath) => (parsed.push(relPath), extractFile(source, relPath)),
  });
  return { files, parsed, indexer };
}

describe('the graph indexer', () => {
  it('parses only what changed since the last refresh', async () => {
    const { files, parsed, indexer } = project({ 'a.js': 'export function a() {}', 'b.js': "import { a } from './a.js';\nexport function b() { a(); }" });
    await indexer.refresh();
    expect(parsed.sort()).toEqual(['a.js', 'b.js']);
    parsed.length = 0;
    await indexer.refresh();
    expect(parsed).toEqual([]);
    files.set('a.js', { source: 'export function a() {}\nexport function c() {}', mtimeMs: 2 });
    await indexer.refresh();
    expect(parsed).toEqual(['a.js']);
    expect(indexer.graph().functions['a.js#c']).toBeDefined();
    files.delete('b.js');
    await indexer.refresh();
    expect(indexer.graph().modules.map((module) => module.id)).toEqual(['a.js']);
  });

  it('touch forces a re-parse even with the same mtime', async () => {
    const { parsed, indexer } = project({ 'a.js': '' });
    await indexer.refresh();
    parsed.length = 0;
    indexer.touch('a.js');
    await indexer.refresh();
    expect(parsed).toEqual(['a.js']);
  });

  it('filters by extension, node_modules, dist, .min.js, size and count', async () => {
    const big = 'x'.repeat(400 * 1024);
    const { indexer } = project({
      'a.js': '',
      'b.ts': '',
      'c.md': '',
      'node_modules/x/i.js': '',
      'dist/out.js': '',
      'vendor/lib.min.js': '',
      'huge.js': big,
    });
    await indexer.refresh();
    expect(indexer.graph().modules.map((module) => module.id)).toEqual(['a.js', 'b.ts']);
    expect(indexer.graph().truncated).toBe(false);

    const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${String(index).padStart(2, '0')}.js`, '']));
    const crowded = project(many);
    const limited = createGraphIndexer({ ...crowded.indexer.options, limits: { maxFiles: 10, maxBytes: 300 * 1024 } });
    await limited.refresh();
    expect(limited.graph().modules).toHaveLength(10);
    expect(limited.graph().truncated).toBe(true);
  });

  it('no JS/TS or listFiles failing: unavailable with the reason', async () => {
    const { indexer } = project({ 'README.md': '' });
    expect(await indexer.refresh()).toEqual({ unavailable: 'nenhum arquivo JS/TS neste projeto' });
    const broken = createGraphIndexer({ root: '/p', listFiles: async () => { throw new Error('not a git repository'); }, statFile: async () => ({}), readFile: async () => '', parse: extractFile });
    expect(await broken.refresh()).toEqual({ unavailable: 'sem git neste projeto' });
  });

  it('emits graph only when it changed', async () => {
    const { files, indexer } = project({ 'a.js': '' });
    let emitted = 0;
    indexer.on('graph', () => emitted++);
    await indexer.refresh();
    await indexer.refresh();
    expect(emitted).toBe(1);
    files.set('a.js', { source: 'function a() {}', mtimeMs: 5 });
    await indexer.refresh();
    expect(emitted).toBe(2);
  });
});

describe('createWorkerParser', () => {
  it('parses in a worker thread', async () => {
    const parser = createWorkerParser();
    try {
      const extract = await parser.parse('export function hi() { bye(); }', 'w.js');
      expect(extract.functions.map((item) => item.name)).toEqual(['<topo>', 'hi']);
    } finally {
      parser.close();
    }
  });
});

describe('the graph indexer, review fixes', () => {
  it('I2: after an edit only the touched file is read again (no listing, no stat of the rest)', async () => {
    const { files, parsed, indexer } = project({ 'a.js': 'export function a() {}', 'b.js': 'export function b() {}' });
    let listed = 0;
    let stats = 0;
    const counted = createGraphIndexer({
      ...indexer.options,
      listFiles: async () => (listed++, indexer.options.listFiles()),
      statFile: async (relPath) => (stats++, indexer.options.statFile(relPath)),
    });
    await counted.refresh();
    [listed, stats] = [0, 0];
    parsed.length = 0;
    files.set('a.js', { source: 'export function a() {}\nexport function c() {}', mtimeMs: 2 });
    counted.touch('a.js');
    await counted.refreshTouched();
    expect([listed, stats]).toEqual([0, 1]);
    expect(parsed).toEqual(['a.js']);
    expect(counted.graph().functions['a.js#c']).toBeDefined();
  });

  it('M2: a failing build does not stop later refreshes', async () => {
    let fail = true;
    const indexer = createGraphIndexer({
      root: '/p',
      listFiles: async () => ['a.js'],
      statFile: async () => ({ mtimeMs: 1, size: 1 }),
      readFile: async () => '',
      parse: async (source, relPath) => {
        if (fail) throw new Error('worker gone');
        return extractFile(source, relPath);
      },
    });
    await expect(indexer.refresh()).rejects.toThrow('worker gone');
    fail = false;
    await indexer.refresh();
    expect(indexer.graph().modules).toHaveLength(1);
  });
});

describe('createWorkerParser, review fixes', () => {
  it('M1: a dead worker is replaced and parses still answer', async () => {
    const parser = createWorkerParser();
    try {
      await parser.worker().terminate();
      const extract = await parser.parse('export function again() {}', 'w.js');
      expect(extract.functions.map((item) => item.name)).toEqual(['<topo>', 'again']);
    } finally {
      parser.close();
    }
  });
});
