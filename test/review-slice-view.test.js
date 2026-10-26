import { describe, expect, it } from 'vitest';
import { layoutSlice, renderSlice, renderSliceStatus } from '../src/renderer/review/slice-view.js';

function twenty() {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 20; i += 1) nodes.push({ id: `n${i}`, kind: 'module', label: `mod${i}`, state: i < 3 ? 'changed' : i < 10 ? 'affected' : 'context', untested: i === 5, layer: i < 4 ? 0 : i < 12 ? 1 : 2 });
  for (let i = 4; i < 20; i += 1) edges.push({ from: `n${i % 4}`, to: `n${i}`, type: i % 3 ? 'call' : 'import' });
  return { nodes, edges, more: [] };
}

describe('layoutSlice', () => {
  it('lays 20 nodes out without overlap, callers above callees, in under 5 ms', () => {
    const slice = twenty();
    layoutSlice(slice, { width: 800, height: 600 });
    const start = performance.now();
    const layout = layoutSlice(slice, { width: 800, height: 600 });
    expect(performance.now() - start).toBeLessThan(5);
    const ids = Object.keys(layout.positions);
    expect(ids).toHaveLength(20);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = layout.positions[ids[i]];
        const b = layout.positions[ids[j]];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
      }
    }
    for (const e of slice.edges) expect(layout.positions[e.from].y).toBeLessThan(layout.positions[e.to].y);
    for (const p of Object.values(layout.positions)) expect(p.x).toBeGreaterThanOrEqual(0);
    expect(layout.width).toBeGreaterThanOrEqual(800);
  });

  it('barycenter ordering untangles a crossing', () => {
    const slice = {
      nodes: [
        { id: 'a', label: 'a', state: 'changed', layer: 0 }, { id: 'b', label: 'b', state: 'changed', layer: 0 },
        { id: 'c', label: 'c', state: 'context', layer: 1 }, { id: 'd', label: 'd', state: 'context', layer: 1 },
      ],
      edges: [{ from: 'a', to: 'd', type: 'call' }, { from: 'b', to: 'c', type: 'call' }],
      more: [],
    };
    const { positions } = layoutSlice(slice, {});
    expect(Math.sign(positions.a.x - positions.b.x)).toBe(Math.sign(positions.d.x - positions.c.x));
  });

  it('puts a parentless more node in the last layer', () => {
    const slice = { nodes: [{ id: 'a', label: 'a', state: 'changed', layer: 0 }, { id: 'b', label: 'b', state: 'context', layer: 1 }], edges: [], more: [{ id: 'more:', parent: null, count: 4, ids: [] }] };
    const { positions } = layoutSlice(slice, {});
    expect(positions['more:'].y).toBe(positions.b.y);
  });

  it('copes with an empty slice', () => {
    expect(layoutSlice({ nodes: [], edges: [], more: [] }, {}).positions).toEqual({});
  });
});

describe('renderSlice', () => {
  const slice = {
    nodes: [
      { id: 'a', kind: 'module', label: 'a.js', state: 'changed', untested: true, layer: 0 },
      { id: 'b', kind: 'module', label: 'b.js', state: 'affected', layer: 1 },
      { id: 'c', kind: 'module', label: 'c.js', state: 'context', layer: 1 },
    ],
    edges: [{ from: 'a', to: 'b', type: 'call' }, { from: 'a', to: 'c', type: 'import' }],
    more: [{ id: 'more:b', parent: 'b', count: 37, ids: [] }],
  };

  it('draws state classes, the untested seal, edge styles and the more node', () => {
    const svg = renderSlice(slice, layoutSlice(slice, {}), { selectedId: 'b' });
    expect(svg).toContain('state-changed');
    expect(svg).toContain('state-affected');
    expect(svg).toContain('state-context');
    expect(svg).toContain('sem teste');
    expect(svg).toContain('+37 outras funções');
    expect(svg).toContain('data-node="more:b"');
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(1);
    expect(svg).toMatch(/slice-node state-affected selected" data-node="b"/);
  });

  it('escapes labels', () => {
    const evil = { nodes: [{ id: 'x"', label: '<script>&', state: 'changed', layer: 0 }], edges: [], more: [] };
    const svg = renderSlice(evil, layoutSlice(evil, {}), {});
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;&amp;');
    expect(svg).toContain('data-node="x&quot;"');
  });
});

describe('renderSliceStatus', () => {
  it('building shows progress, or none when the total is unknown', () => {
    expect(renderSliceStatus({ status: 'building', done: 3, total: 10 })).toContain('lendo o projeto… 3/10 arquivos');
    const bare = renderSliceStatus({ status: 'building', done: 0, total: 0 });
    expect(bare).toContain('lendo o projeto…');
    expect(bare).not.toMatch(/\d/);
  });
  it('unavailable shows the escaped reason; ready shows nothing', () => {
    expect(renderSliceStatus({ status: 'unavailable', reason: 'sem <git>' })).toContain('sem &lt;git&gt;');
    expect(renderSliceStatus({ status: 'ready', slice: {} })).toBe('');
  });
});
