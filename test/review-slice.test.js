import { describe, expect, it } from 'vitest';
import { linkGraph } from '../src/main/graph/link.js';
import { touchedFunctions } from '../src/main/graph/impact.js';
import { egoSlice, filesOfNode, isTestPath, ubiquitous, untestedModules } from '../src/main/review/slice.js';

// spec: { 'a.js': { fns: ['run'], imports: { './b.js': ['go'] }, calls: { run: ['go'] } } }
// A call is to a name imported from the file that the import line names.
function graphOf(spec) {
  const extracts = new Map();
  for (const [id, { fns = ['run'], imports = {}, calls = {} }] of Object.entries(spec)) {
    extracts.set(id, {
      functions: fns.map((name, index) => ({ id: `${id}#${name}`, name, startLine: index * 10 + 1, endLine: index * 10 + 9 })),
      imports: Object.entries(imports).flatMap(([from, names]) => names.map((name) => ({ from, local: name, imported: name }))),
      calls: Object.entries(calls).flatMap(([from, names]) => names.map((name) => ({ from: `${id}#${from}`, callee: { kind: 'local', name } }))),
    });
  }
  return linkGraph(extracts);
}

// center.js#run is called by `callers` modules and calls `callees` ones.
function star(callers, callees) {
  const spec = { 'center.js': { fns: ['run'], imports: {}, calls: { run: [] } } };
  for (let i = 0; i < callers; i += 1) spec[`in${String(i).padStart(2, '0')}.js`] = { fns: ['up'], imports: { './center.js': ['run'] }, calls: { up: ['run'] } };
  for (let i = 0; i < callees; i += 1) {
    spec[`out${String(i).padStart(2, '0')}.js`] = { fns: ['down'] };
    spec['center.js'].imports[`./out${String(i).padStart(2, '0')}.js`] = ['down'];
    spec['center.js'].calls.run.push('down');
  }
  return graphOf(spec);
}

const byId = (slice) => Object.fromEntries(slice.nodes.map((node) => [node.id, node]));

describe('isTestPath', () => {
  it('recognises test folders and test file names', () => {
    expect(isTestPath('test/a.js')).toBe(true);
    expect(isTestPath('src/__tests__/a.js')).toBe(true);
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('src/a.spec.mjs')).toBe(true);
    expect(isTestPath('src/latest/a.js')).toBe(false);
    expect(isTestPath('src/a.js')).toBe(false);
  });
});

describe('egoSlice, module level', () => {
  it('one changed function: one changed node, the neighbours affected', () => {
    const graph = star(2, 2);
    const slice = egoSlice(graph, ['center.js#run']);
    const nodes = byId(slice);
    expect(slice.nodes).toHaveLength(5);
    expect(nodes['center.js']).toMatchObject({ kind: 'module', state: 'changed' });
    expect(nodes['in00.js'].state).toBe('affected');
    expect(nodes['out00.js'].state).toBe('affected');
    expect(slice.edges).toContainEqual({ from: 'in00.js', to: 'center.js', type: 'call' });
    expect(slice.edges).toContainEqual({ from: 'center.js', to: 'out01.js', type: 'call' });
    expect(slice.more).toEqual([]);
  });

  it('an import with no call is an import edge', () => {
    const graph = graphOf({ 'a.js': { imports: { './b.js': ['x'] } }, 'b.js': { fns: ['x'] } });
    expect(egoSlice(graph, ['a.js#run']).edges).toEqual([{ from: 'a.js', to: 'b.js', type: 'import' }]);
  });

  it('expanding a module swaps it for its functions in the slice', () => {
    const graph = graphOf({
      'a.js': { fns: ['run', 'other'], imports: { './b.js': ['go'] }, calls: { run: ['go'] } },
      'b.js': { fns: ['go', 'unused'] },
    });
    const slice = egoSlice(graph, ['a.js#run'], { expanded: ['a.js'] });
    const nodes = byId(slice);
    expect(nodes['a.js']).toBeUndefined();
    expect(nodes['a.js#run']).toMatchObject({ kind: 'function', label: 'run', state: 'changed' });
    expect(nodes['a.js#other']).toBeUndefined();
    expect(nodes['b.js']).toMatchObject({ kind: 'module', state: 'affected' });
    expect(slice.edges).toEqual([{ from: 'a.js#run', to: 'b.js', type: 'call' }]);
  });

  it('expanding both ends links the exact functions', () => {
    const graph = graphOf({
      'a.js': { fns: ['run'], imports: { './b.js': ['go'] }, calls: { run: ['go'] } },
      'b.js': { fns: ['go', 'unused'] },
    });
    const slice = egoSlice(graph, ['a.js#run'], { expanded: ['a.js', 'b.js'] });
    expect(slice.nodes.map((node) => node.id).sort()).toEqual(['a.js#run', 'b.js#go']);
    expect(slice.edges).toEqual([{ from: 'a.js#run', to: 'b.js#go', type: 'call' }]);
  });

  it('hop2:<id> adds the second hop as context, and only that node', () => {
    const graph = graphOf({
      'a.js': { imports: { './b.js': ['go'] }, calls: { run: ['go'] } },
      'b.js': { fns: ['go'], imports: { './c.js': ['deep'] }, calls: { go: ['deep'] } },
      'c.js': { fns: ['deep'], imports: { './d.js': ['far'] }, calls: { deep: ['far'] } },
      'd.js': { fns: ['far'] },
    });
    expect(byId(egoSlice(graph, ['a.js#run']))['c.js']).toBeUndefined();
    const slice = egoSlice(graph, ['a.js#run'], { expanded: ['hop2:b.js'] });
    const nodes = byId(slice);
    expect(nodes['c.js'].state).toBe('context');
    expect(nodes['d.js']).toBeUndefined();
    expect(slice.edges).toContainEqual({ from: 'b.js', to: 'c.js', type: 'call' });
  });

  it('hides a ubiquitous util unless showHidden', () => {
    const spec = { 'center.js': { imports: { './util/log.js': ['log'] }, calls: { run: ['log'] } }, 'util/log.js': { fns: ['log'] } };
    for (let i = 0; i < 16; i += 1) {
      spec[`m${i}.js`] = { imports: { './util/log.js': ['log'] }, calls: { run: ['log'] } };
    }
    const graph = graphOf(spec);
    expect(ubiquitous(graph).has('util/log.js#log')).toBe(true);
    expect(byId(egoSlice(graph, ['center.js#run']))['util/log.js']).toBeUndefined();
    expect(byId(egoSlice(graph, ['center.js#run'], { showHidden: true }))['util/log.js']).toBeDefined();
  });

  it('a function called from exactly 15 modules is not ubiquitous', () => {
    const spec = { 'util.js': { fns: ['f'] } };
    for (let i = 0; i < 15; i += 1) spec[`m${i}.js`] = { imports: { './util.js': ['f'] }, calls: { run: ['f'] } };
    expect(ubiquitous(graphOf(spec)).size).toBe(0);
  });

  it('hides test modules unless showHidden', () => {
    const graph = graphOf({ 'a.js': {}, 'test/a.test.js': { imports: { '../a.js': ['run'] }, calls: { run: ['run'] } } });
    expect(byId(egoSlice(graph, ['a.js#run']))['test/a.test.js']).toBeUndefined();
    expect(byId(egoSlice(graph, ['a.js#run'], { showHidden: true }))['test/a.test.js']).toBeDefined();
  });

  it('40 neighbours: at most 20 nodes and a more with the right count', () => {
    const graph = star(20, 20);
    const slice = egoSlice(graph, ['center.js#run']);
    expect(slice.nodes.length).toBeLessThanOrEqual(20);
    expect(slice.nodes.find((node) => node.id === 'center.js').state).toBe('changed');
    expect(slice.more).toHaveLength(1);
    expect(slice.more[0]).toMatchObject({ id: 'more:center.js', parent: 'center.js', count: 21 });
    expect(slice.more[0].ids).toHaveLength(21);
    const shown = new Set(slice.nodes.map((node) => node.id));
    expect(slice.more[0].ids.every((id) => !shown.has(id))).toBe(true);
    expect(slice.edges.every((edge) => shown.has(edge.from) && shown.has(edge.to))).toBe(true);
  });

  it('changed nodes never collapse, even when they alone pass the limit', () => {
    const spec = {};
    for (let i = 0; i < 25; i += 1) spec[`c${String(i).padStart(2, '0')}.js`] = { fns: ['run'] };
    spec['c00.js'].imports = { './c01.js': ['run'] };
    spec['c00.js'].calls = { run: ['run'] };
    const graph = graphOf(spec);
    const slice = egoSlice(graph, Object.keys(spec).map((id) => `${id}#run`));
    expect(slice.nodes).toHaveLength(20);
    expect(slice.nodes.every((node) => node.state === 'changed')).toBe(true);
    expect(slice.more).toHaveLength(1);
    expect(slice.more[0].count).toBe(5);
    // The connected ones stay; the lonely ones are the excess.
    expect(slice.nodes.map((node) => node.id)).toContain('c00.js');
  });

  it('the caller gets a smaller layer than the callee', () => {
    const graph = star(1, 1);
    const nodes = byId(egoSlice(graph, ['center.js#run']));
    expect(nodes['in00.js'].layer).toBeLessThan(nodes['center.js'].layer);
    expect(nodes['center.js'].layer).toBeLessThan(nodes['out00.js'].layer);
  });

  it('layers follow the longest path', () => {
    const graph = graphOf({
      'a.js': { imports: { './b.js': ['b'], './c.js': ['c'] }, calls: { run: ['b'] } },
      'b.js': { fns: ['b'], imports: { './c.js': ['c'] }, calls: { b: ['c'] } },
      'c.js': { fns: ['c'] },
    });
    // a -> b -> c and a -> c: c sits under b, not beside it.
    graph.callEdges.push({ from: 'a.js#run', to: 'c.js#c' });
    const nodes = byId(egoSlice(graph, ['a.js#run', 'b.js#b', 'c.js#c']));
    expect([nodes['a.js'].layer, nodes['b.js'].layer, nodes['c.js'].layer]).toEqual([0, 1, 2]);
  });

  it('a cycle A -> B -> A does not hang and gives stable layers', () => {
    const spec = {
      'a.js': { fns: ['a'], imports: { './b.js': ['b'] }, calls: { a: ['b'] } },
      'b.js': { fns: ['b'], imports: { './a.js': ['a'] }, calls: { b: ['a'] } },
    };
    const first = egoSlice(graphOf(spec), ['a.js#a']);
    const second = egoSlice(graphOf(spec), ['a.js#a']);
    expect(first.nodes).toEqual(second.nodes);
    const nodes = byId(first);
    expect(nodes['a.js'].layer).toBe(0);
    expect(nodes['b.js'].layer).toBe(1);
  });

  it('a new file: all its functions changed', () => {
    const graph = graphOf({ 'a.js': { fns: ['one', 'two', 'three'] } });
    const changed = touchedFunctions(graph, 'a.js', null, 'whatever');
    expect(changed).toHaveLength(3);
    const slice = egoSlice(graph, changed, { expanded: ['a.js'] });
    expect(slice.nodes.map((node) => node.state)).toEqual(['changed', 'changed', 'changed']);
  });

  it('a changed function the graph does not know is ignored', () => {
    expect(egoSlice(star(1, 1), ['nope.js#x'])).toEqual({ nodes: [], edges: [], more: [] });
  });
});

describe('untestedModules', () => {
  it('a module only a test imports is not untested; one nobody tests is', () => {
    const graph = graphOf({
      'a.js': {},
      'b.js': {},
      'test/a.test.js': { imports: { '../a.js': ['run'] }, calls: { run: ['run'] } },
    });
    const untested = untestedModules(graph);
    expect(untested.has('a.js')).toBe(false);
    expect(untested.has('b.js')).toBe(true);
    expect(untested.has('test/a.test.js')).toBe(false);
  });

  it('one hop through another module counts, two hops do not', () => {
    const graph = graphOf({
      'a.js': { imports: { './b.js': ['b'] } },
      'b.js': { fns: ['b'], imports: { './c.js': ['c'] } },
      'c.js': { fns: ['c'] },
      'test/a.test.js': { imports: { '../a.js': ['run'] } },
    });
    const untested = untestedModules(graph);
    expect(untested.has('b.js')).toBe(false);
    expect(untested.has('c.js')).toBe(true);
  });

  it('marks the nodes of the slice', () => {
    const graph = graphOf({ 'a.js': { imports: { './b.js': ['b'] } }, 'b.js': { fns: ['b'] } });
    const nodes = byId(egoSlice(graph, ['a.js#run']));
    expect(nodes['a.js'].untested).toBe(true);
  });
});

describe('filesOfNode', () => {
  it('gives the file of a module and the file with lines of a function', () => {
    const graph = graphOf({ 'a.js': { fns: ['one', 'two'] } });
    expect(filesOfNode(graph, 'a.js')).toEqual({ files: ['a.js'], range: null });
    expect(filesOfNode(graph, 'a.js#two')).toEqual({ files: ['a.js'], range: { startLine: 11, endLine: 19 } });
    expect(filesOfNode(graph, 'nope.js')).toBeNull();
  });
});

describe('performance', () => {
  it('slices a 3000-module graph in under 30 ms (3x tolerance)', () => {
    const spec = {};
    for (let i = 0; i < 3000; i += 1) {
      const next = (i * 7 + 1) % 3000;
      spec[`src/m${i}.js`] = { fns: ['run'], imports: { [`./m${next}.js`]: ['run'] }, calls: { run: ['run'] } };
    }
    const graph = graphOf(spec);
    const changed = ['src/m10.js#run', 'src/m20.js#run'];
    egoSlice(graph, changed);
    const start = performance.now();
    egoSlice(graph, changed);
    expect(performance.now() - start).toBeLessThan(90);
  });
});
