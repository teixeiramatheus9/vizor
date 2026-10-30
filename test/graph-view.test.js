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

describe('the layout never piles nodes up (live test: "um em cima do outro")', async () => {
  const { openArea } = await import('../src/renderer/graph-view.js');
  // A crowded project: one folder with 80 files of mixed sizes, a few small folders.
  const crowded = {
    modules: [
      ...Array.from({ length: 80 }, (_, index) => ({ id: `src/main/f${index}.js`, group: 'src/main', functions: Array.from({ length: (index * 7) % 60 }, (_, f) => `src/main/f${index}.js#g${f}`) })),
      ...Array.from({ length: 30 }, (_, index) => ({ id: `test/t${index}.js`, group: 'test', functions: ['x'] })),
      ...['a', 'b', 'c', 'd', 'e'].map((name) => ({ id: `src/${name}/m.js`, group: `src/${name}`, functions: ['y'] })),
    ],
    moduleEdges: [],
    callEdges: [],
    functions: {},
  };
  const layout = layoutGraph(crowded, { width: 1000, height: 1000 });
  const nodes = Object.values(layout.modules);

  it('files never overlap', () => {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const [a, b] = [nodes[i], nodes[j]];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 0.01);
      }
  });

  it('folders never overlap, and every file stays in its folder', () => {
    const groups = Object.values(layout.groups);
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) expect(Math.hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y)).toBeGreaterThanOrEqual(groups[i].r + groups[j].r - 0.01);
    for (const module of crowded.modules) {
      const group = layout.groups[module.group];
      const node = layout.modules[module.id];
      expect(Math.hypot(node.x - group.x, node.y - group.y) + node.r).toBeLessThanOrEqual(group.r + 0.01);
    }
  });

  it('everything fits the drawing', () => {
    for (const group of Object.values(layout.groups)) {
      expect(group.x - group.r).toBeGreaterThanOrEqual(0);
      expect(group.y - group.r).toBeGreaterThanOrEqual(0);
      expect(group.x + group.r).toBeLessThanOrEqual(1000);
      expect(group.y + group.r).toBeLessThanOrEqual(1000);
    }
  });

  it("an open file's functions sit on a backdrop and never overlap each other", () => {
    const big = {
      ...crowded,
      functions: Object.fromEntries(crowded.modules.flatMap((module) => module.functions.map((fnId, index) => [fnId, { module: module.id, name: `g${index}`, startLine: 1, endLine: 2 }]))),
    };
    const open = 'src/main/f8.js'; // 56 functions
    const svg = renderGraph({ graph: big, layout, view: { scale: 3, x: 0, y: 0, open }, impacts: [] });
    expect(svg).toContain('class="open-backdrop"');
    const spots = [...svg.matchAll(/data-function="[^"]+" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(([, x, y, r]) => ({ x: +x, y: +y, r: +r }));
    expect(spots).toHaveLength(56);
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y)).toBeGreaterThan(spots[i].r + spots[j].r);
    // A click on the backdrop is not a click on the file underneath.
    const area = openArea(big, layout, open);
    expect(moduleAt(layout, { scale: 1, x: 0, y: 0, open }, area.x + area.r * 0.5, area.y)).toBeNull();
  });
});

describe('an opened file never hides its neighbours (live test: "cobre o outro")', async () => {
  const { openArea } = await import('../src/renderer/graph-view.js');
  // One folder, a big file with many functions and three small neighbours.
  const tight = linkGraph(
    new Map([
      ['src/a/big.js', extractFile(Array.from({ length: 40 }, (_, index) => `export function f${index}() {}`).join('\n'), 'src/a/big.js')],
      ['src/a/n1.js', extractFile("import { f1 } from './big.js';\nexport function n() { f1(); }", 'src/a/n1.js')],
      ['src/a/n2.js', extractFile('export function n() {}', 'src/a/n2.js')],
      ['src/a/n3.js', extractFile('export function n() {}', 'src/a/n3.js')],
    ]),
  );
  const layout = layoutGraph(tight, { width: 1000, height: 1000 });
  const open = 'src/a/big.js';
  const view = { scale: 3, x: 0, y: 0, open };
  const svg = renderGraph({ graph: tight, layout, view, impacts: [] });
  const area = openArea(tight, layout, open);
  const shown = (id) => {
    const match = svg.match(new RegExp(`data-module="${id.replace(/[/.]/g, (char) => `\\${char}`)}"[^>]*cx="([\\d.]+)" cy="([\\d.]+)" r="([\\d.]+)"`));
    return { x: +match[1], y: +match[2], r: +match[3] };
  };

  it('the files under the backdrop move to its rim, still drawn', () => {
    for (const id of ['src/a/n1.js', 'src/a/n2.js', 'src/a/n3.js']) {
      const node = shown(id);
      expect(Math.hypot(node.x - area.x, node.y - area.y) - node.r).toBeGreaterThanOrEqual(area.r);
    }
  });

  it('moved files never overlap each other', () => {
    const nodes = ['src/a/n1.js', 'src/a/n2.js', 'src/a/n3.js'].map(shown);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) expect(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)).toBeGreaterThanOrEqual(nodes[i].r + nodes[j].r);
  });

  it('a click on a moved file finds it where it is drawn', () => {
    const node = shown('src/a/n2.js');
    expect(moduleAt(layout, { ...view, scale: 1 }, node.x, node.y)).toBe('src/a/n2.js');
  });

  it('closed again, every file is back in its place', () => {
    const closed = renderGraph({ graph: tight, layout, view: { scale: 1, x: 0, y: 0, open: null }, impacts: [] });
    const node = layout.modules['src/a/n2.js'];
    expect(closed).toContain(`data-module="src/a/n2.js" cx="${node.x}" cy="${node.y}"`);
  });
});

describe('opening a file in a crowded folder', async () => {
  const { openArea } = await import('../src/renderer/graph-view.js');
  it('no file moved to the rim touches any other file', () => {
    const crowded = linkGraph(
      new Map([
        ['src/m/hub.js', extractFile(Array.from({ length: 150 }, (_, index) => `export function f${index}() {}`).join('\n'), 'src/m/hub.js')],
        ...Array.from({ length: 70 }, (_, index) => [`src/m/n${index}.js`, extractFile(Array.from({ length: index % 9 }, (_, f) => `export function g${f}() {}`).join('\n'), `src/m/n${index}.js`)]),
      ]),
    );
    const layout = layoutGraph(crowded, { width: 1000, height: 1000 });
    const area = openArea(crowded, layout, 'src/m/hub.js');
    const shown = Object.entries(layout.modules)
      .filter(([id]) => id !== 'src/m/hub.js')
      .map(([id, node]) => area.moved[id] ?? node);
    expect(Object.keys(area.moved).length).toBeGreaterThan(10);
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++) expect(Math.hypot(shown[i].x - shown[j].x, shown[i].y - shown[j].y)).toBeGreaterThanOrEqual(shown[i].r + shown[j].r - 0.01);
  });
});

describe('links between modules, readable at every zoom', async () => {
  const { FILE_LINKS_ZOOM } = await import('../src/renderer/graph-view.js');
  // ui imports core 3 times, core imports util once, util imports nothing.
  const linked = linkGraph(
    new Map([
      ['ui/a.js', extractFile("import { c } from '../core/c.js';", 'ui/a.js')],
      ['ui/b.js', extractFile("import { c } from '../core/c.js';", 'ui/b.js')],
      ['ui/d.js', extractFile("import { e } from '../core/e.js';", 'ui/d.js')],
      ['core/c.js', extractFile("import { u } from '../util/u.js';\nexport function c() {}", 'core/c.js')],
      ['core/e.js', extractFile('export function e() {}', 'core/e.js')],
      ['util/u.js', extractFile('export function u() {}', 'util/u.js')],
    ]),
  );
  const layout = layoutGraph(linked, { width: 1000, height: 1000 });
  const far = { scale: 1, x: 0, y: 0, open: null };
  const width = (svg, from, to) => Number(svg.match(new RegExp(`class="folder-link[^"]*" data-link="${from}~${to}"[^>]*stroke-width="([\\d.]+)"`))?.[1]);

  it('far away: one line per pair of folders, thicker with more imports; no file lines', () => {
    const svg = renderGraph({ graph: linked, layout, view: far, impacts: [] });
    expect(svg.match(/class="folder-link/g)).toHaveLength(2);
    expect(width(svg, 'core', 'ui')).toBeGreaterThan(width(svg, 'core', 'util'));
    expect(svg).not.toMatch(/class="import"/);
  });

  it('zoomed in: the file lines show', () => {
    const svg = renderGraph({ graph: linked, layout, view: { ...far, scale: FILE_LINKS_ZOOM }, impacts: [] });
    expect(svg.match(/class="import"/g)).toHaveLength(4);
  });

  it("a selected file's links light up at any zoom, in and out", () => {
    const svg = renderGraph({ graph: linked, layout, view: { ...far, selected: 'core/c.js' }, impacts: [] });
    expect(svg.match(/class="import picked"/g)).toHaveLength(3); // a→c, b→c, c→u
  });

  it("a músico's links stay lit far away too", () => {
    const svg = renderGraph({ graph: linked, layout, view: far, impacts: [{ color: '#ebcb8b', modules: { 'util/u.js': 'touched' }, functions: {} }] });
    expect(svg).toMatch(/class="import lit"[^>]*stroke="#ebcb8b"/);
    expect(svg).toMatch(/class="folder-link lit" data-link="core~util"[^>]*stroke="#ebcb8b"/);
  });
});

describe('a clicked node shows its links (live test: "tenho que ver o vínculo")', () => {
  const calls = linkGraph(
    new Map([
      ['core/c.js', extractFile('export function c() { helper(); }\nfunction helper() {}\nexport function idle() {}', 'core/c.js')],
      ['ui/a.js', extractFile("import { c } from '../core/c.js';\nexport function a() { c(); }", 'ui/a.js')],
    ]),
  );
  const layout = layoutGraph(calls, { width: 1000, height: 1000 });
  const view = { scale: 3, x: 0, y: 0, open: 'core/c.js' };

  it('an opened file also shows who calls it from elsewhere', () => {
    const svg = renderGraph({ graph: calls, layout, view, impacts: [] });
    expect(svg).toContain('data-function="ui/a.js#a"');
  });

  it("a clicked function's calls light up, in and out", () => {
    const svg = renderGraph({ graph: calls, layout, view: { ...view, selected: 'core/c.js#c' }, impacts: [] });
    expect(svg.match(/class="call picked"/g)).toHaveLength(2); // a→c, c→helper
    const idle = renderGraph({ graph: calls, layout, view: { ...view, selected: 'core/c.js#idle' }, impacts: [] });
    expect(idle).not.toContain('class="call picked"');
  });
});
