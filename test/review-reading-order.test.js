import { describe, expect, it } from 'vitest';
import { linkGraph } from '../src/main/graph/link.js';
import { readingOrder } from '../src/main/review/reading-order.js';

const f = (path) => ({ path, added: 1, removed: 0 });
const paths = (list) => list.map((x) => x.path);

describe('readingOrder', () => {
  const files = ['test/a.test.js', 'src/z.js', 'src/b.js', 'src/a.css', 'src/c.js', 'README.md'].map(f);

  it('puts contract first, code by path, tests and styles last without a graph', () => {
    expect(paths(readingOrder(files, { contractPaths: ['src/z.js'] }))).toEqual(
      ['src/z.js', 'src/b.js', 'src/c.js', 'README.md', 'src/a.css', 'test/a.test.js']);
  });

  it('orders code by callers among the changed files with a graph', () => {
    const ex = (id, calls = [], imports = [], withGo = true) => ({
      functions: [{ id: `${id}#run`, name: 'run', startLine: 1, endLine: 5 }, ...(withGo ? [{ id: `${id}#go`, name: 'go', startLine: 6, endLine: 9 }] : [])],
      imports, calls,
    });
    const imp = (from) => [{ from, local: 'go', imported: 'go' }];
    const call = (id) => [{ from: `${id}#run`, callee: { kind: 'local', name: 'go' } }];
    const graph = linkGraph(new Map([
      ['src/a.js', ex('src/a.js')],
      ['src/b.js', ex('src/b.js')],
      ['src/x.js', ex('src/x.js', call('src/x.js'), imp('./b.js'), false)],
      ['src/y.js', ex('src/y.js', call('src/y.js'), imp('./b.js'), false)],
      ['src/outside.js', ex('src/outside.js', call('src/outside.js'), imp('./a.js'), false)],
    ]));
    const changed = ['src/a.js', 'src/b.js', 'src/x.js', 'src/y.js'].map(f);
    expect(paths(readingOrder(changed, { graph }))).toEqual(['src/b.js', 'src/a.js', 'src/x.js', 'src/y.js']);
  });
});
