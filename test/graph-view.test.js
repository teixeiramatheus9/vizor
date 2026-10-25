import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';
import { linkGraph } from '../src/main/graph/link.js';
import { layoutGraph, moduleAt, renderGraph, ZOOM_OPEN } from '../src/renderer/graph-view.js';

const graph = linkGraph(
  new Map(
    Object.entries({
      'src/main/tts.js': "import { pick } from './voice/pick.js';\nexport function speak() { pick(); say(); }\nfunction say() {}",
      'src/main/voice/pick.js': 'export function pick() {}',
      'src/main/voice/<odd>.js': 'export function x() {}',
      'test/tts.test.js': '',
    }).map(([relPath, source]) => [relPath, extractFile(source, relPath)]),
  ),
);
const view = { scale: 1, x: 0, y: 0, open: null };

describe('the Maestro graph view', () => {
  it('layout is deterministic and keeps modules inside their group', () => {
    const a = layoutGraph(graph, { width: 1000, height: 1000 });
    expect(layoutGraph(graph, { width: 1000, height: 1000 })).toEqual(a);
    expect(Object.keys(a.groups).sort()).toEqual(['src/main', 'src/main/voice', 'test']);
    for (const module of graph.modules) {
      const group = a.groups[module.group];
      const node = a.modules[module.id];
      expect(Math.hypot(node.x - group.x, node.y - group.y)).toBeLessThanOrEqual(group.r);
    }
  });

  it('renders every module once, with its path as a title, escaped', () => {
    const svg = renderGraph({ graph, layout: layoutGraph(graph, { width: 1000, height: 1000 }), view, impacts: [] });
    expect(svg.match(/data-module=/g)).toHaveLength(4);
    expect(svg).toContain('<title>src/main/tts.js</title>');
    expect(svg).toContain('&lt;odd&gt;');
    expect(svg).not.toContain('<odd>');
  });

  it('touched modules are filled, planned ones dashed, in the músico color', () => {
    const svg = renderGraph({
      graph,
      layout: layoutGraph(graph, { width: 1000, height: 1000 }),
      view,
      impacts: [{ color: '#ebcb8b', modules: { 'src/main/tts.js': 'touched', 'src/main/voice/pick.js': 'planned' }, functions: {} }],
    });
    expect(svg).toMatch(/data-module="src\/main\/tts\.js"[^>]*fill="#ebcb8b"/);
    expect(svg).toMatch(/data-module="src\/main\/voice\/pick\.js"[^>]*stroke="#ebcb8b"[^>]*stroke-dasharray/);
  });

  it('an open module shows its functions and call edges', () => {
    const svg = renderGraph({
      graph,
      layout: layoutGraph(graph, { width: 1000, height: 1000 }),
      view: { ...view, scale: ZOOM_OPEN + 1, open: 'src/main/tts.js' },
      impacts: [{ color: '#a3be8c', modules: {}, functions: { 'src/main/tts.js#speak': 'touched' } }],
    });
    expect(svg).toContain('data-function="src/main/tts.js#speak"');
    expect(svg).toContain('data-function="src/main/tts.js#say"');
    // speak() calls pick() in another module: shown at the edge, smaller.
    expect(svg).toContain('data-function="src/main/voice/pick.js#pick"');
    expect(svg.match(/class="call"/g)).toHaveLength(2);
    expect(svg).toMatch(/data-function="src\/main\/tts\.js#speak"[^>]*fill="#a3be8c"/);
  });

  it('moduleAt finds the module under a point at any zoom', () => {
    const layout = layoutGraph(graph, { width: 1000, height: 1000 });
    const node = layout.modules['src/main/tts.js'];
    expect(moduleAt(layout, view, node.x, node.y)).toBe('src/main/tts.js');
    const zoomed = { scale: 3, x: -100, y: -50, open: null };
    expect(moduleAt(layout, zoomed, node.x * 3 - 100, node.y * 3 - 50)).toBe('src/main/tts.js');
    expect(moduleAt(layout, view, -500, -500)).toBeNull();
  });

  it('unavailable graph renders the reason', () => {
    const html = renderGraph({ graph: { unavailable: 'sem git <neste> projeto' }, layout: null, view, impacts: [] });
    expect(html).toContain('grafo indisponível: sem git &lt;neste&gt; projeto');
  });
});
