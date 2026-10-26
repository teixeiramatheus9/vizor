import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';
import { linkGraph } from '../src/main/graph/link.js';
import { impactOf, parsePlan, touchedFunctions } from '../src/main/graph/impact.js';

const graphOf = (sources) => linkGraph(new Map(Object.entries(sources).map(([relPath, source]) => [relPath, extractFile(source, relPath)])));

const BEFORE = ['function first() {', '  return 1;', '}', '', 'function second() {', '  return 2;', '}'].join('\n');
// Five lines inserted inside first(): second() moves down by five but is untouched.
const AFTER = ['function first() {', '  const a = 1;', '  const b = 2;', '  const c = 3;', '  const d = 4;', '  const e = 5;', '  return 1;', '}', '', 'function second() {', '  return 2;', '}'].join('\n');

describe('touchedFunctions', () => {
  it('a hunk lights the function it falls in, on the current lines', () => {
    const graph = graphOf({ 'a.js': AFTER });
    expect(touchedFunctions(graph, 'a.js', BEFORE, AFTER)).toEqual(['a.js#first']);
  });

  it('a removal marks the function where it happened', () => {
    const removed = BEFORE.replace('  return 2;\n', '');
    const graph = graphOf({ 'a.js': removed });
    expect(touchedFunctions(graph, 'a.js', BEFORE, removed)).toEqual(['a.js#second']);
  });

  it('a new file lights all its functions', () => {
    const graph = graphOf({ 'a.js': BEFORE });
    expect(touchedFunctions(graph, 'a.js', null, BEFORE)).toEqual(['a.js#<topo>', 'a.js#first', 'a.js#second']);
  });

  it('a file the graph does not have touches nothing', () => {
    expect(touchedFunctions(graphOf({}), 'x.js', '', 'a')).toEqual([]);
  });
});

describe('parsePlan', () => {
  it('the last Vizor-plano line, files and functions, relative to the root', () => {
    const text = 'Plano:\n1. ...\nVizor-plano: src/a.js\n\nMudei de ideia.\nVizor-plano: src/main/tts.js#speak, src/main/voice/session.js , `src/x.ts#K.m`';
    expect(parsePlan(text, '/p')).toEqual([
      { module: 'src/main/tts.js', fn: 'speak' },
      { module: 'src/main/voice/session.js', fn: null },
      { module: 'src/x.ts', fn: 'K.m' },
    ]);
  });

  it('parsePlan drops absolute paths outside the root and ..', () => {
    expect(parsePlan('Vizor-plano: /p/src/a.js#f, /etc/passwd, ../out.js, src/../../x.js, ', '/p')).toEqual([{ module: 'src/a.js', fn: 'f' }]);
    expect(parsePlan('nada aqui', '/p')).toEqual([]);
    expect(parsePlan(null, '/p')).toEqual([]);
  });
});

describe('impactOf', () => {
  it('touched wins over planned; unknown items are ignored', () => {
    const graph = graphOf({ 'a.js': BEFORE, 'b.js': 'export function g() {}' });
    const impact = impactOf(graph, {
      touched: ['a.js#first', 'zzz.js#nope'],
      touchedModules: ['a.js', 'gone.js'],
      planned: [
        { module: 'a.js', fn: 'first' },
        { module: 'a.js', fn: 'second' },
        { module: 'b.js', fn: null },
        { module: 'c.js', fn: 'x' },
      ],
    });
    expect(impact).toEqual({
      modules: { 'a.js': 'touched', 'b.js': 'planned' },
      functions: { 'a.js#first': 'touched', 'a.js#second': 'planned' },
    });
  });
});
