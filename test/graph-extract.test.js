import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';

const SOURCE = [
  "import fs from 'node:fs';", // 1
  "import { speak, stop as halt } from './tts.js';", // 2
  "import * as voice from './voice/session.js';", // 3
  'function a() {', // 4
  '  b();', // 5
  '  voice.run();', // 6
  '}', // 7
  'const b = () => {', // 8
  '  speak();', // 9
  '};', // 10
  'export function c() {', // 11
  '  halt();', // 12
  '}', // 13
  'class K {', // 14
  '  m() {', // 15
  '    a();', // 16
  '  }', // 17
  '}', // 18
  'export default function () {}', // 19
  'a();', // 20
].join('\n');

const fn = (extract, name) => extract.functions.find((item) => item.name === name);

describe('extractFile', () => {
  it('functions, arrows, methods and the top level, with their lines', () => {
    const extract = extractFile(SOURCE, 'src/x.js');
    expect(extract.error).toBeNull();
    expect(extract.functions.map((item) => item.id)).toEqual([
      'src/x.js#<topo>',
      'src/x.js#a',
      'src/x.js#b',
      'src/x.js#c',
      'src/x.js#K.m',
      'src/x.js#default',
    ]);
    expect(fn(extract, 'a')).toMatchObject({ startLine: 4, endLine: 7 });
    expect(fn(extract, 'b')).toMatchObject({ startLine: 8, endLine: 10 });
    expect(fn(extract, 'K.m')).toMatchObject({ startLine: 15, endLine: 17 });
    expect(fn(extract, '<topo>')).toMatchObject({ startLine: 1, endLine: 20 });
  });

  it('imports: named, default, namespace, and their source', () => {
    expect(extractFile(SOURCE, 'src/x.js').imports).toEqual([
      { local: 'fs', imported: 'default', from: 'node:fs' },
      { local: 'speak', imported: 'speak', from: './tts.js' },
      { local: 'halt', imported: 'stop', from: './tts.js' },
      { local: 'voice', imported: '*', from: './voice/session.js' },
    ]);
  });

  it('calls are attributed to the function they are in', () => {
    const { calls } = extractFile(SOURCE, 'src/x.js');
    expect(calls).toEqual(
      expect.arrayContaining([
        { from: 'src/x.js#a', callee: { kind: 'local', name: 'b' } },
        { from: 'src/x.js#a', callee: { kind: 'member', name: 'run', object: 'voice' } },
        { from: 'src/x.js#b', callee: { kind: 'local', name: 'speak' } },
        { from: 'src/x.js#c', callee: { kind: 'local', name: 'halt' } },
        { from: 'src/x.js#K.m', callee: { kind: 'local', name: 'a' } },
        { from: 'src/x.js#<topo>', callee: { kind: 'local', name: 'a' } },
      ]),
    );
  });

  it('TypeScript and JSX parse', () => {
    const tsx = 'type P = { n: number };\nexport function View(props: P): JSX.Element {\n  return <div>{format(props.n)}</div>;\n}\n';
    const extract = extractFile(tsx, 'ui/view.tsx');
    expect(extract.error).toBeNull();
    expect(extract.functions.map((item) => item.name)).toEqual(['<topo>', 'View']);
    expect(extract.calls).toContainEqual({ from: 'ui/view.tsx#View', callee: { kind: 'local', name: 'format' } });
  });

  it('a syntax error leaves the file with only its top level and the error', () => {
    const extract = extractFile('function broken( {\n  if (\n', 'src/broken.js');
    expect(extract.error).toEqual(expect.any(String));
    expect(extract.functions.map((item) => item.name)).toEqual(['<topo>']);
    expect(extract.imports).toEqual([]);
    expect(extract.calls).toEqual([]);
  });
});
