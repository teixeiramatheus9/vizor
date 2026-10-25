import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';
import { linkGraph, resolveImport } from '../src/main/graph/link.js';

const files = (sources) => new Map(Object.entries(sources).map(([relPath, source]) => [relPath, extractFile(source, relPath)]));

describe('linkGraph', () => {
  it('module edges from relative imports, resolved with extensions and index files', () => {
    const known = new Set(['src/a.js', 'src/b.ts', 'src/lib/index.js', 'src/c.ts']);
    expect(resolveImport('src/a.js', './b', known)).toBe('src/b.ts');
    expect(resolveImport('src/a.js', './lib', known)).toBe('src/lib/index.js');
    expect(resolveImport('src/a.js', './c.js', known)).toBe('src/c.ts');
    expect(resolveImport('src/a.js', 'node:fs', known)).toBeNull();
    expect(resolveImport('src/a.js', '../../out.js', known)).toBeNull();
    const graph = linkGraph(files({ 'src/a.js': "import { f } from './b';\nimport './lib';", 'src/b.ts': 'export function f() {}', 'src/lib/index.js': '' }));
    expect(graph.moduleEdges).toEqual([
      { from: 'src/a.js', to: 'src/b.ts' },
      { from: 'src/a.js', to: 'src/lib/index.js' },
    ]);
  });

  it('call edges: local, named import, default import and namespace member', () => {
    const graph = linkGraph(
      files({
        'src/a.js': [
          "import { speak as say } from './tts.js';",
          "import run from './run.js';",
          "import * as voice from './voice.js';",
          'function local() {}',
          'export function main() { local(); say(); run(); voice.listen(); voice.nope(); unknown(); }',
        ].join('\n'),
        'src/tts.js': 'export function speak() {}',
        'src/run.js': 'export default function () {}',
        'src/voice.js': 'export function listen() {}',
      }),
    );
    expect(graph.callEdges).toEqual([
      { from: 'src/a.js#main', to: 'src/a.js#local' },
      { from: 'src/a.js#main', to: 'src/tts.js#speak' },
      { from: 'src/a.js#main', to: 'src/run.js#default' },
      { from: 'src/a.js#main', to: 'src/voice.js#listen' },
    ]);
    expect(graph.functions['src/tts.js#speak']).toMatchObject({ module: 'src/tts.js', name: 'speak' });
  });

  it('imports of packages and of files outside the graph make no edge', () => {
    const graph = linkGraph(files({ 'src/a.js': "import x from 'react';\nimport y from './ignored.js';\nexport function f() { x(); y(); }" }));
    expect(graph.moduleEdges).toEqual([]);
    expect(graph.callEdges).toEqual([]);
  });

  it('a circular import is two edges, no loop', () => {
    const graph = linkGraph(files({ 'a.js': "import { b } from './b.js';\nexport function a() { b(); }", 'b.js': "import { a } from './a.js';\nexport function b() { a(); }" }));
    expect(graph.moduleEdges).toEqual([
      { from: 'a.js', to: 'b.js' },
      { from: 'b.js', to: 'a.js' },
    ]);
    expect(graph.callEdges).toHaveLength(2);
  });

  it('groups are the folders', () => {
    const graph = linkGraph(files({ 'src/main/voice/session.js': '', 'src/main/tts.js': '', 'root.js': '' }));
    expect(graph.modules.map((module) => [module.id, module.group])).toEqual([
      ['root.js', '.'],
      ['src/main/tts.js', 'src/main'],
      ['src/main/voice/session.js', 'src/main/voice'],
    ]);
    expect(graph.modules[1].functions).toEqual(['src/main/tts.js#<topo>']);
  });
});

describe('linkGraph on a big repo (review C1: it blocked the main process for 7 s)', () => {
  it('3000 files with object-less member calls link in well under a second', () => {
    const extracts = new Map();
    for (let file = 0; file < 3000; file++) {
      const relPath = `src/f${file}.js`;
      extracts.set(relPath, {
        functions: [
          { id: `${relPath}#<topo>`, name: '<topo>', startLine: 1, endLine: 10 },
          { id: `${relPath}#K.run`, name: 'K.run', startLine: 2, endLine: 5 },
        ],
        imports: [],
        calls: [
          { from: `${relPath}#K.run`, callee: { kind: 'member', name: 'run' } },
          { from: `${relPath}#K.run`, callee: { kind: 'member', name: 'other' } },
        ],
        error: null,
      });
    }
    const start = Date.now();
    linkGraph(extracts);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('this.helper() still resolves to the unique same-file method', () => {
    const graph = linkGraph(files({ 'k.js': 'class K { a() { this.b(); } b() {} }' }));
    expect(graph.callEdges).toEqual([{ from: 'k.js#K.a', to: 'k.js#K.b' }]);
  });
});
