// The Maestro graph (#159), as an SVG string: the folders (parts of the
// system) on a circle, their files inside, import edges between files. A file
// opened (by click, or by zooming past ZOOM_OPEN) shows its functions around
// it, with the calls they make — into other files too, drawn smaller at the
// edge. Each músico lights what it touched (filled) and what it plans to
// touch (dashed) in its own color. Pure: workspace.js owns the view state.
import { escapeHtml } from './workspace-view.js';

export const ZOOM_OPEN = 2.2;
const SIZE = 1000; // the drawing's own units; the SVG scales to the column
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

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
    const group = { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle), r };
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

const paint = (light) =>
  !light
    ? 'fill="var(--graph-node, #4c566a)"'
    : light.state === 'touched'
      ? `fill="${escapeHtml(light.color)}"`
      : `fill="none" stroke="${escapeHtml(light.color)}" stroke-width="2" stroke-dasharray="4 3"`;

const shortName = (relPath) => relPath.split('/').pop();

function openModule(graph, layout, impacts, moduleId, scale) {
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
  const font = 9 / scale;
  const edges = calls
    .map((call) => {
      const a = placed[call.from];
      const b = placed[call.to];
      return `<line class="call" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--graph-call, #81a1c1)" stroke-width="${1 / scale}"/>`;
    })
    .join('');
  const nodes = Object.entries(placed)
    .map(([fnId, node]) => {
      const fn = graph.functions[fnId];
      const label = node.own ? fn.name : `${shortName(fn.module)} · ${fn.name}`;
      return `<g><circle data-function="${escapeHtml(fnId)}" cx="${node.x}" cy="${node.y}" r="${node.r}" ${paint(lightOf(impacts, 'functions', fnId))}><title>${escapeHtml(
        `${fn.module} · ${fn.name} (linhas ${fn.startLine}–${fn.endLine})`,
      )}</title></circle><text x="${node.x + node.r + 2 / scale}" y="${node.y + font / 3}" font-size="${font}" class="fn-label${node.own ? '' : ' outside'}">${escapeHtml(label)}</text></g>`;
    })
    .join('');
  return `<g class="open-module">${edges}${nodes}</g>`;
}

export function renderGraph({ graph, layout, view, impacts = [] }) {
  if (!graph) return '<div class="graph-unavailable">montando o grafo…</div>';
  if (graph.unavailable) return `<div class="graph-unavailable">grafo indisponível: ${escapeHtml(graph.unavailable)}</div>`;
  const { scale, x, y, open } = view;
  const font = 12 / scale;
  const groups = Object.entries(layout.groups)
    .map(
      ([name, group]) =>
        `<g class="group"><circle cx="${group.x}" cy="${group.y}" r="${group.r}" class="group-area"/><text x="${group.x}" y="${group.y - group.r - 4 / scale}" font-size="${font}" text-anchor="middle" class="group-label">${escapeHtml(name)}</text></g>`,
    )
    .join('');
  const edges = graph.moduleEdges
    .map(({ from, to }) => {
      const a = layout.modules[from];
      const b = layout.modules[to];
      return a && b ? `<line class="import" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${0.6 / scale}"/>` : '';
    })
    .join('');
  const modules = graph.modules
    .map((module) => {
      const node = layout.modules[module.id];
      const opened = module.id === open ? ' class="opened"' : '';
      return `<circle data-module="${escapeHtml(module.id)}"${opened} cx="${node.x}" cy="${node.y}" r="${node.r}" ${paint(lightOf(impacts, 'modules', module.id))}><title>${escapeHtml(module.id)}</title></circle>`;
    })
    .join('');
  const label = open && layout.modules[open]
    ? `<text x="${layout.modules[open].x}" y="${layout.modules[open].y - layout.modules[open].r - 6 / scale}" font-size="${font}" text-anchor="middle" class="module-label">${escapeHtml(shortName(open))}</text>`
    : '';
  const opened = open && layout.modules[open] ? openModule(graph, layout, impacts, open, scale) : '';
  const truncated = graph.truncated ? '<text x="10" y="20" class="graph-note">projeto grande: só os primeiros 3000 arquivos</text>' : '';
  return `<svg class="graph" viewBox="0 0 ${SIZE} ${SIZE}" preserveAspectRatio="xMidYMid meet">${truncated}<g transform="translate(${x} ${y}) scale(${scale})">${groups}${edges}${modules}${label}${opened}</g></svg>`;
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
