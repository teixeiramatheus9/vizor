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
export const GROUP_COLORS = ['#5e81ac', '#8fbcbb', '#b48ead', '#d08770', '#a3be8c', '#ebcb8b', '#88c0d0', '#bf8a6e', '#7b88a8', '#9fb08a'];

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

export function layoutGraph(graph, { width = SIZE, height = SIZE } = {}) {
  const byGroup = new Map();
  for (const module of graph.modules) {
    if (!byGroup.has(module.group)) byGroup.set(module.group, []);
    byGroup.get(module.group).push(module);
  }
  const names = [...byGroup.keys()].sort();
  const cx = width / 2;
  const cy = height / 2;
  const ring = names.length > 1 ? Math.min(width, height) * 0.36 : 0;
  const room = names.length > 1 ? ring * Math.sin(Math.PI / names.length) * 0.92 : Math.min(width, height) * 0.45;
  const groups = {};
  const modules = {};
  names.forEach((name, index) => {
    const angle = (2 * Math.PI * index) / names.length - Math.PI / 2;
    const members = byGroup.get(name);
    const r = Math.min(room, 26 + 14 * Math.sqrt(members.length));
    const group = { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle), r, color: GROUP_COLORS[index % GROUP_COLORS.length] };
    groups[name] = group;
    members.forEach((module, place) => {
      const distance = r * 0.82 * Math.sqrt((place + 0.5) / members.length);
      const turn = place * GOLDEN;
      modules[module.id] = {
        x: group.x + distance * Math.cos(turn),
        y: group.y + distance * Math.sin(turn),
        r: 3 + 1.4 * Math.sqrt(module.functions.length),
      };
    });
  });
  return { groups, modules };
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
  const center = layout.modules[moduleId];
  const own = graph.modules.find((module) => module.id === moduleId)?.functions ?? [];
  const placed = {};
  const inner = center.r + 40;
  own.forEach((fnId, index) => {
    const angle = (2 * Math.PI * index) / Math.max(own.length, 1) - Math.PI / 2;
    placed[fnId] = { x: center.x + inner * Math.cos(angle), y: center.y + inner * Math.sin(angle), r: 4, own: true };
  });
  const calls = graph.callEdges.filter((call) => placed[call.from]?.own);
  const outside = [...new Set(calls.map((call) => call.to).filter((fnId) => !placed[fnId]))];
  outside.forEach((fnId, index) => {
    const angle = (2 * Math.PI * index) / Math.max(outside.length, 1) - Math.PI / 2 + 0.2;
    placed[fnId] = { x: center.x + (inner + 36) * Math.cos(angle), y: center.y + (inner + 36) * Math.sin(angle), r: 2.6, own: false };
  });
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
        `${fn.module} · ${fn.name} (linhas ${fn.startLine}–${fn.endLine})`,
      )}</title></circle>`;
    })
    .join('');
  return { svg: `<g class="open-module">${edges}${nodes}</g>`, placed };
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
    const a = layout.modules[from];
    const b = layout.modules[to];
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
      const node = layout.modules[module.id];
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
  const opened = open && layout.modules[open] ? openModule(graph, layout, impacts, critical, open, scale) : { svg: '', placed: {} };
  let label = '';
  if (selected && layout.modules[selected]) {
    label = selectedLabel(selected, layout.modules[selected].x, layout.modules[selected].y - layout.modules[selected].r, scale);
  } else if (selected && opened.placed[selected]) {
    const fn = graph.functions[selected];
    label = selectedLabel(`${shortName(fn.module)} · ${fn.name} (${fn.startLine}–${fn.endLine})`, opened.placed[selected].x, opened.placed[selected].y - 4, scale);
  }
  const truncated = graph.truncated ? '<text x="10" y="24" class="graph-note">projeto grande: só os primeiros 3000 arquivos</text>' : '';
  return `<svg class="graph" viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="xMidYMid meet">${truncated}<g transform="translate(${x} ${y}) scale(${scale})">${groups}${faint.join('')}${lit.join('')}${modules}${opened.svg}${label}</g></svg>`;
}

// px, py in the drawing's units (0..1000), as the view shows them.
export function moduleAt(layout, view, px, py) {
  const gx = (px - view.x) / view.scale;
  const gy = (py - view.y) / view.scale;
  let best = null;
  let bestDistance = Infinity;
  for (const [id, node] of Object.entries(layout.modules)) {
    const distance = Math.hypot(node.x - gx, node.y - gy);
    if (distance <= node.r + 4 / view.scale && distance < bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}
