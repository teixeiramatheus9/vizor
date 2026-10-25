import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/main/graph/extract.js';
import { linkGraph } from '../src/main/graph/link.js';
import { criticalOf, GROUP_COLORS, layoutGraph, moduleAt, renderGraph, ZOOM_OPEN, ZOOM_STEP } from '../src/renderer/graph-view.js';

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

  it('touched modules get a thick ring in the músico color, planned ones a dashed ring', () => {
    const svg = renderGraph({
      graph,
      layout: layoutGraph(graph, { width: 1000, height: 1000 }),
      view,
      impacts: [{ color: '#ebcb8b', modules: { 'src/main/tts.js': 'touched', 'src/main/voice/pick.js': 'planned' }, functions: {} }],
    });
    expect(svg).toMatch(/class="ring touched"[^>]*data-ring="src\/main\/tts\.js"[^>]*stroke="#ebcb8b"/);
    expect(svg).toMatch(/class="ring planned"[^>]*data-ring="src\/main\/voice\/pick\.js"[^>]*stroke="#ebcb8b"[^>]*stroke-dasharray/);
  });

  it('the links of a touched node light up in the músico color', () => {
    const svg = renderGraph({
      graph,
      layout: layoutGraph(graph, { width: 1000, height: 1000 }),
      view,
      impacts: [{ color: '#ebcb8b', modules: { 'src/main/tts.js': 'touched' }, functions: {} }],
    });
    // tts.js imports voice/pick.js: that edge is lit.
    expect(svg).toMatch(/class="import lit"[^>]*stroke="#ebcb8b"/);
  });

  it('each folder has its own color, and its files carry it', () => {
    const svg = renderGraph({ graph, layout: layoutGraph(graph, { width: 1000, height: 1000 }), view, impacts: [] });
    const fill = (id) => svg.match(new RegExp(`data-module="${id.replace(/[/.]/g, (char) => `\\${char}`)}"[^>]*fill="([^"]+)"`))[1];
    expect(fill('src/main/voice/pick.js')).toBe(fill('src/main/voice/<odd>.js'.replace(/[<>]/g, (char) => (char === '<' ? '&lt;' : '&gt;'))));
    expect(fill('src/main/tts.js')).not.toBe(fill('src/main/voice/pick.js'));
    expect(GROUP_COLORS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(GROUP_COLORS).size).toBe(GROUP_COLORS.length);
  });

  it('only folder names are written; a file or function name shows when it is selected', () => {
    const layout = layoutGraph(graph, { width: 1000, height: 1000 });
    const plain = renderGraph({ graph, layout, view: { ...view, scale: ZOOM_OPEN + 1, open: 'src/main/tts.js' }, impacts: [] });
    expect(plain).toContain('>src/main/voice<');
    expect(plain).not.toContain('>speak<');
    expect(plain).not.toContain('>tts.js<');
    const picked = renderGraph({ graph, layout, view: { ...view, scale: ZOOM_OPEN + 1, open: 'src/main/tts.js', selected: 'src/main/tts.js#speak' }, impacts: [] });
    expect(picked).toContain('class="selected-label"');
    expect(picked).toContain('speak');
    expect(renderGraph({ graph, layout, view: { ...view, selected: 'src/main/tts.js' }, impacts: [] })).toContain('src/main/tts.js');
  });

  it('labels keep a readable size on screen at any zoom', () => {
    const layout = layoutGraph(graph, { width: 1000, height: 1000 });
    const size = (scale) => Number(renderGraph({ graph, layout, view: { ...view, scale }, impacts: [] }).match(/class="group-label"[^>]*font-size="([\d.]+)"|font-size="([\d.]+)"[^>]*class="group-label"/).slice(1).find(Boolean));
    expect(size(1)).toBeGreaterThanOrEqual(20);
    expect(size(4) * 4).toBeCloseTo(size(1), 5);
  });

  it('zoom steps are strong enough to reach the functions in a few turns', () => {
    expect(ZOOM_STEP).toBeGreaterThanOrEqual(1.3);
    expect(ZOOM_STEP ** 3).toBeGreaterThan(ZOOM_OPEN);
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
    expect(svg.match(/class="call[ "]/g)).toHaveLength(2);
    // speak() was touched: its calls are lit in the músico's color.
    expect(svg.match(/class="call lit"/g)).toHaveLength(2);
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

describe('critical nodes and links (red)', () => {
  // hub.js is imported by 9 files: a change there reaches all of them.
  const hubGraph = linkGraph(
    new Map([
      ['src/hub.js', extractFile('export function core() {}', 'src/hub.js')],
      ...Array.from({ length: 9 }, (_, index) => [`src/u${index}.js`, extractFile("import { core } from './hub.js';\nexport function use() { core(); }", `src/u${index}.js`)]),
    ]),
  );

  it('a small project still has critical files: at least 4 importers, or the top 5%', () => {
    const small = linkGraph(
      new Map([
        ['src/core.js', extractFile('export function c() {}', 'src/core.js')],
        ...Array.from({ length: 4 }, (_, index) => [`src/s${index}.js`, extractFile("import { c } from './core.js';", `src/s${index}.js`)]),
      ]),
    );
    expect([...criticalOf(small).modules]).toEqual(['src/core.js']);
  });

  it('criticalOf: files many import and functions many call', () => {
    const critical = criticalOf(hubGraph);
    expect(critical.modules.has('src/hub.js')).toBe(true);
    expect(critical.modules.has('src/u0.js')).toBe(false);
    expect(critical.functions.has('src/hub.js#core')).toBe(true);
  });

  it('a critical node always has a red outline; touched, it and its links go strong red', () => {
    const layout = layoutGraph(hubGraph, { width: 1000, height: 1000 });
    const calm = renderGraph({ graph: hubGraph, layout, view, impacts: [] });
    expect(calm).toMatch(/data-module="src\/hub\.js"[^>]*class="critical"|class="critical"[^>]*data-module="src\/hub\.js"/);
    const hot = renderGraph({ graph: hubGraph, layout, view, impacts: [{ color: '#a3be8c', modules: { 'src/hub.js': 'touched' }, functions: {} }] });
    expect(hot).toMatch(/class="ring touched danger"[^>]*data-ring="src\/hub\.js"[^>]*stroke="#bf616a"/);
    expect(hot).toMatch(/class="import lit danger"[^>]*stroke="#bf616a"/);
  });
});
