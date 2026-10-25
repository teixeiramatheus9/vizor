// The Maestro graph (#159), as an SVG string: the folders (parts of the
// system) on a circle, their files inside, import edges between files. A file
// opened (by click, or by zooming past ZOOM_OPEN) shows its functions around
// it, with the calls they make — into other files too, drawn smaller at the
// edge. Each músico lights what it touched (filled) and what it plans to
// touch (dashed) in its own color. Pure: workspace.js owns the view state.
import { escapeHtml } from './workspace-view.js';

export const ZOOM_OPEN = 2.2;
export const ZOOM_STEP = 1.35; // per wheel notch: a few turns reach the functions
export const ZOOM_MAX = 30;
const SIZE = 1000; // the drawing's own units; the SVG scales to the column
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const LABEL = 22; // label size at zoom 1, in drawing units (~13 px in the column)
const DANGER = '#bf616a';
// One color per folder (a part of the system), its files carry it. Soft, so a
// músico's ring in its own color stands out on top.
export const GROUP_COLORS = ['#5e81ac', '#a3be8c', '#b48ead', '#d08770', '#88c0d0', '#ebcb8b', '#c97fa0', '#8fbcbb', '#9a8fd1', '#d4a373', '#6fb37a', '#7aa6d6', '#c2b36b', '#a88a7a'];

// What many depend on: a file imported by many (at least 4, or the top 5%),
// a function called by many (at least 8, or the top 5%). Changing it
// reaches far: red on the graph.
const CRITICAL_MIN = { modules: 4, functions: 8 };
function hubs(counts, minimum) {
  const values = [...counts.values()].sort((a, b) => a - b);
  const p95 = values.length ? values[Math.floor(values.length * 0.95)] : Infinity;
  const threshold = Math.max(minimum, p95);
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([id]) => id));
}
export function criticalOf(graph) {
  const importers = new Map();
  for (const { from, to } of graph.moduleEdges) importers.set(to, (importers.get(to) ?? new Set()).add(from));
  const callers = new Map();
  for (const { from, to } of graph.callEdges) callers.set(to, (callers.get(to) ?? new Set()).add(from));
  const size = (map) => new Map([...map].map(([id, set]) => [id, set.size]));
  return { modules: hubs(size(importers), CRITICAL_MIN.modules), functions: hubs(size(callers), CRITICAL_MIN.functions) };
}

// Files inside a folder never touch: they start on a sunflower spiral and are
// pushed apart until none overlaps; folders are then fitted around each other
// on a spiral from the middle, and the whole drawing is scaled to fit
// (live test: nodes piled up). Deterministic: same graph, same picture.
const GAP = 1.5;
const MARGIN = 30;

function packFolder(members) {
  const nodes = members.map((module) => ({ id: module.id, r: 3 + 1.4 * Math.sqrt(module.functions.length), x: 0, y: 0 }));
  const mean = nodes.reduce((sum, node) => sum + node.r, 0) / Math.max(nodes.length, 1);
  nodes.forEach((node, index) => {
    const distance = (2 * mean + GAP) * 0.62 * Math.sqrt(index + 0.5);
    node.x = distance * Math.cos(index * GOLDEN);
    node.y = distance * Math.sin(index * GOLDEN);
  });
  for (let round = 0; round < 400; round++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        const want = a.r + b.r + GAP;
        if (distance >= want) continue;
        if (distance < 1e-6) [dx, dy, distance] = [1, 0, 1]; // same spot: split along x
        const push = (want - distance) / 2 + 0.01;
        a.x -= (dx / distance) * push;
        a.y -= (dy / distance) * push;
        b.x += (dx / distance) * push;
        b.y += (dy / distance) * push;
        moved = true;
      }
    if (!moved) break;
  }
  // Recentred on the folder's middle; the folder is as big as its farthest file.
  const cx = nodes.reduce((sum, node) => sum + node.x, 0) / Math.max(nodes.length, 1);
  const cy = nodes.reduce((sum, node) => sum + node.y, 0) / Math.max(nodes.length, 1);
  for (const node of nodes) [node.x, node.y] = [node.x - cx, node.y - cy];
  const r = Math.max(...nodes.map((node) => Math.hypot(node.x, node.y) + node.r), 6) + 8;
  return { nodes, r };
}

export function layoutGraph(graph, { width = SIZE, height = SIZE } = {}) {
  const byGroup = new Map();
  for (const module of graph.modules) {
    if (!byGroup.has(module.group)) byGroup.set(module.group, []);
    byGroup.get(module.group).push(module);
  }
  const names = [...byGroup.keys()].sort();
  const packed = Object.fromEntries(names.map((name) => [name, packFolder(byGroup.get(name))]));
  // The biggest folder in the middle, the rest on a spiral, each at the first
  // spot that touches none placed before.
  const order = [...names].sort((a, b) => packed[b].r - packed[a].r || a.localeCompare(b));
  const placed = [];
  // The spiral only goes outward: each folder starts where the last one was
  // put, so 500 folders cost a walk, not 500 (a 3000-file repo took 2.3 s).
  let t = 0;
  for (const name of order) {
    const r = packed[name].r;
    let spot = { x: 0, y: 0 };
    for (; ; t += 0.05) {
      const candidate = { x: 4 * t * Math.cos(t), y: 4 * t * Math.sin(t) };
      if (placed.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) >= other.r + r + 14)) {
        spot = candidate;
        break;
      }
    }
    placed.push({ name, r, ...spot });
  }
  // Scaled and moved to fit the drawing.
  const left = Math.min(...placed.map((group) => group.x - group.r));
  const right = Math.max(...placed.map((group) => group.x + group.r));
  const top = Math.min(...placed.map((group) => group.y - group.r));
  const bottom = Math.max(...placed.map((group) => group.y + group.r));
  const k = Math.min((width - 2 * MARGIN) / Math.max(right - left, 1), (height - 2 * MARGIN) / Math.max(bottom - top, 1));
  const ox = (width - (right - left) * k) / 2 - left * k;
  const oy = (height - (bottom - top) * k) / 2 - top * k;
  const groups = {};
  const modules = {};
  for (const group of placed) {
    const color = GROUP_COLORS[names.indexOf(group.name) % GROUP_COLORS.length];
    groups[group.name] = { x: group.x * k + ox, y: group.y * k + oy, r: group.r * k, color };
    for (const node of packed[group.name].nodes)
      modules[node.id] = { x: (group.x + node.x) * k + ox, y: (group.y + node.y) * k + oy, r: node.r * k };
  }
  return { groups, modules, openAreas: {} };
}

// An opened file: its functions on a sunflower inside a backdrop that covers
// the neighbours, the functions it calls elsewhere on the rim. Memoized on
// the layout, so a click on the backdrop is not a click on what lies under.
const FN_R = 4;
const FN_SPACING = 10.5;
export function openArea(graph, layout, moduleId) {
  if (layout.openAreas?.[moduleId]) return layout.openAreas[moduleId];
  const center = layout.modules[moduleId];
  const own = graph.modules.find((module) => module.id === moduleId)?.functions ?? [];
  const spots = {};
  own.forEach((fnId, index) => {
    const distance = FN_SPACING * Math.sqrt(index + 0.5);
    spots[fnId] = { x: center.x + distance * Math.cos(index * GOLDEN), y: center.y + distance * Math.sin(index * GOLDEN), r: FN_R, own: true };
  });
  const inner = FN_SPACING * Math.sqrt(own.length + 0.5) + 10;
  const outside = [...new Set(graph.callEdges.filter((call) => spots[call.from]?.own && !spots[call.to]).map((call) => call.to))].slice(0, Math.floor((2 * Math.PI * (inner + 14)) / 9));
  outside.forEach((fnId, index) => {
    const angle = (2 * Math.PI * index) / Math.max(outside.length, 1) - Math.PI / 2;
    spots[fnId] = { x: center.x + (inner + 14) * Math.cos(angle), y: center.y + (inner + 14) * Math.sin(angle), r: 2.6, own: false };
  });
  const area = { x: center.x, y: center.y, r: inner + 26, spots, moved: moveAside(layout, moduleId, center, inner + 26) };
  if (layout.openAreas) layout.openAreas[moduleId] = area;
  return area;
}

// The files the backdrop would cover go to its rim, in the direction they
// were, spread so none touches another — still drawn, still clickable (live
// test: an opened file hid its neighbour). A full ring starts another.
function moveAside(layout, openId, center, radius) {
  const under = Object.entries(layout.modules)
    .filter(([id, node]) => id !== openId && Math.hypot(node.x - center.x, node.y - center.y) < radius + node.r)
    .map(([id, node]) => ({ id, r: node.r, angle: Math.atan2(node.y - center.y, node.x - center.x) }))
    .sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id));
  const moved = {};
  if (!under.length) return moved;
  const biggest = Math.max(...under.map((node) => node.r));
  let ring = radius + biggest + 3;
  let previous = null;
  let first = null;
  for (const node of under) {
    let angle = node.angle;
    if (previous) angle = Math.max(angle, previous.angle + (previous.r + node.r + GAP * 2) / ring);
    // No room left on this ring before reaching the first one again: next ring out.
    if (first && angle + (node.r + first.r + GAP * 2) / ring > first.angle + 2 * Math.PI) {
      ring += 2 * biggest + 4;
      angle = node.angle;
      first = null;
      previous = null;
    }
    moved[node.id] = { x: center.x + ring * Math.cos(angle), y: center.y + ring * Math.sin(angle), r: node.r, angle, distance: ring };
    previous = { angle, r: node.r };
    first ??= { angle, r: node.r };
  }
  // A moved file landing on one just past the rim keeps going out along its
  // own direction until it touches nothing.
  const still = Object.entries(layout.modules).filter(([id]) => id !== openId && !moved[id]).map(([, node]) => node);
  const clear = (id, spot) =>
    still.every((other) => Math.hypot(other.x - spot.x, other.y - spot.y) >= other.r + spot.r + GAP) &&
    Object.entries(moved).every(([otherId, other]) => otherId === id || Math.hypot(other.x - spot.x, other.y - spot.y) >= other.r + spot.r + GAP);
  for (const [id, spot] of Object.entries(moved)) {
    for (let step = 0; step < 400 && !clear(id, spot); step++) {
      spot.distance += 2;
      spot.x = center.x + spot.distance * Math.cos(spot.angle);
      spot.y = center.y + spot.distance * Math.sin(spot.angle);
    }
  }
  return Object.fromEntries(Object.entries(moved).map(([id, { x, y, r }]) => [id, { x, y, r }]));
}

// One state per item: any músico's touch wins over any plan.
function lightOf(impacts, kind, id) {
  let planned = null;
  for (const impact of impacts) {
    const state = impact[kind]?.[id];
    if (state === 'touched') return { state, color: impact.color };
    if (state === 'planned' && !planned) planned = { state, color: impact.color };
  }
  return planned;
}

const shortName = (relPath) => relPath.split('/').pop();

// A touched node gets a thick ring in the músico's color (dashed when only
// planned); a critical one touched goes red. The ring sits over the node.
function ring(id, node, light, critical, scale) {
  if (!light) return '';
  const color = critical ? DANGER : light.color;
  const kind = `${light.state}${critical ? ' danger' : ''}`;
  const dash = light.state === 'planned' ? ` stroke-dasharray="${6 / scale} ${4 / scale}"` : '';
  return `<circle class="ring ${kind}" data-ring="${escapeHtml(id)}" cx="${node.x}" cy="${node.y}" r="${node.r + 5 / scale}" fill="none" stroke="${escapeHtml(color)}" stroke-width="${4 / scale}"${dash}/>`;
}

function functionPaint(light, critical) {
  if (!light) return `fill="var(--graph-fn, #d8dee9)"${critical ? ` stroke="${DANGER}" stroke-width="1.2"` : ''}`;
  const color = critical ? DANGER : light.color;
  return light.state === 'touched'
    ? `fill="${escapeHtml(color)}"`
    : `fill="none" stroke="${escapeHtml(color)}" stroke-width="2" stroke-dasharray="3 2"`;
}

function openModule(graph, layout, impacts, critical, moduleId, scale) {
  const area = openArea(graph, layout, moduleId);
  const placed = area.spots;
  const calls = graph.callEdges.filter((call) => placed[call.from]?.own && placed[call.to]);
  const edges = calls
    .map((call) => {
      const a = placed[call.from];
      const b = placed[call.to];
      const light = lightOf(impacts, 'functions', call.from) ?? lightOf(impacts, 'functions', call.to);
      const danger = light && (critical.functions.has(call.from) || critical.functions.has(call.to));
      const stroke = danger ? DANGER : light ? light.color : 'var(--graph-call, #81a1c1)';
      return `<line class="call${light ? ' lit' : ''}${danger ? ' danger' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${escapeHtml(stroke)}" stroke-width="${(light ? 2.5 : 1) / scale}"/>`;
    })
    .join('');
  const nodes = Object.entries(placed)
    .map(([fnId, node]) => {
      const fn = graph.functions[fnId];
      const isCritical = critical.functions.has(fnId);
      return `<circle data-function="${escapeHtml(fnId)}" cx="${node.x}" cy="${node.y}" r="${node.r}" ${functionPaint(lightOf(impacts, 'functions', fnId), isCritical)}><title>${escapeHtml(
        `${fn?.module ?? ''} · ${fn?.name ?? fnId} (linhas ${fn?.startLine}–${fn?.endLine})`,
      )}</title></circle>`;
    })
    .join('');
  const backdrop = `<circle class="open-backdrop" cx="${area.x}" cy="${area.y}" r="${area.r}"/>`;
  return { backdrop, svg: `<g class="open-module">${edges}${nodes}</g>`, placed, moved: area.moved };
}

// The name of what was clicked, on a plate so it reads over anything.
function selectedLabel(text, x, y, scale) {
  const size = LABEL / scale;
  const width = (text.length * size * 0.6 + size) | 0;
  return `<g class="selected-label"><rect x="${x - width / 2}" y="${y - size * 1.9}" width="${width}" height="${size * 1.4}" rx="${size * 0.3}"/><text x="${x}" y="${y - size * 0.85}" font-size="${size}" text-anchor="middle">${escapeHtml(text)}</text></g>`;
}

export function renderGraph({ graph, layout, view, impacts = [] }) {
  if (!graph) return '<div class="graph-unavailable">montando o grafo…</div>';
  if (graph.unavailable) return `<div class="graph-unavailable">grafo indisponível: ${escapeHtml(graph.unavailable)}</div>`;
  const { scale, x, y, open, selected = null } = view;
  const critical = criticalOf(graph);
  const opened = open && layout.modules[open] ? openModule(graph, layout, impacts, critical, open, scale) : { backdrop: '', svg: '', placed: {}, moved: {} };
  // Where each file is drawn: in its place, or on the rim of an opened one.
  const at = (id) => opened.moved[id] ?? layout.modules[id];
  const font = LABEL / scale;
  const groups = Object.entries(layout.groups)
    .map(
      ([name, group]) =>
        `<g class="group"><circle cx="${group.x}" cy="${group.y}" r="${group.r}" class="group-area" stroke="${group.color}"/><text class="group-label" x="${group.x}" y="${group.y - group.r - 6 / scale}" font-size="${font}" text-anchor="middle" fill="${group.color}">${escapeHtml(name)}</text></g>`,
    )
    .join('');
  // Links of a touched node light up in the músico's color; red when one end
  // is critical. The rest stay faint.
  const lit = [];
  const faint = [];
  for (const { from, to } of graph.moduleEdges) {
    const a = at(from);
    const b = at(to);
    if (!a || !b) continue;
    const light = lightOf(impacts, 'modules', from) ?? lightOf(impacts, 'modules', to);
    if (!light) {
      faint.push(`<line class="import" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${0.6 / scale}"/>`);
      continue;
    }
    const danger = critical.modules.has(from) || critical.modules.has(to);
    lit.push(
      `<line class="import lit${danger ? ' danger' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${escapeHtml(danger ? DANGER : light.color)}" stroke-width="${2.5 / scale}"${light.state === 'planned' ? ` stroke-dasharray="${6 / scale} ${4 / scale}"` : ''}/>`,
    );
  }
  const groupOf = Object.fromEntries(graph.modules.map((module) => [module.id, layout.groups[module.group]?.color ?? GROUP_COLORS[0]]));
  const modules = graph.modules
    .map((module) => {
      const node = at(module.id);
      const isCritical = critical.modules.has(module.id);
      const classes = [module.id === open && 'opened', isCritical && 'critical'].filter(Boolean).join(' ');
      const outline = isCritical ? ` stroke="${DANGER}" stroke-width="${1.5 / scale}"` : '';
      return `<circle data-module="${escapeHtml(module.id)}"${classes ? ` class="${classes}"` : ''} cx="${node.x}" cy="${node.y}" r="${node.r}" fill="${groupOf[module.id]}"${outline}><title>${escapeHtml(module.id)}</title></circle>${ring(
        module.id,
        node,
        lightOf(impacts, 'modules', module.id),
        isCritical,
        scale,
      )}`;
    })
    .join('');
  let label = '';
  if (selected && layout.modules[selected]) {
    label = selectedLabel(selected, at(selected).x, at(selected).y - at(selected).r, scale);
  } else if (selected && opened.placed[selected]) {
    const fn = graph.functions[selected];
    label = selectedLabel(`${shortName(fn.module)} · ${fn.name} (${fn.startLine}–${fn.endLine})`, opened.placed[selected].x, opened.placed[selected].y - 4, scale);
  }
  const truncated = graph.truncated ? '<text x="10" y="24" class="graph-note">projeto grande: só os primeiros 3000 arquivos</text>' : '';
  return `<svg class="graph" viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="xMidYMid meet">${truncated}<g transform="translate(${x} ${y}) scale(${scale})">${groups}${faint.join('')}${lit.join('')}${opened.backdrop}${modules}${opened.svg}${label}</g></svg>`;
}

// px, py in the drawing's units (0..1000), as the view shows them.
export function moduleAt(layout, view, px, py) {
  const gx = (px - view.x) / view.scale;
  const gy = (py - view.y) / view.scale;
  const area = view.open ? layout.openAreas?.[view.open] : null;
  const moved = area?.moved ?? {};
  // A file moved to the rim is found where it is drawn, before anything else.
  for (const [id, node] of Object.entries(moved)) if (Math.hypot(node.x - gx, node.y - gy) <= node.r + 4 / view.scale) return id;
  if (area && Math.hypot(gx - area.x, gy - area.y) <= area.r) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const [id, node] of Object.entries(layout.modules)) {
    if (moved[id]) continue;
    const distance = Math.hypot(node.x - gx, node.y - gy);
    if (distance <= node.r + 4 / view.scale && distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}
