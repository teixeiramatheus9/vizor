// The review's Impacto tab: a layered layout of the change's slice of the graph
// (callers above callees) and its SVG. Pure; fixed spacing, no physics.
import { escapeHtml } from '../workspace-view.js';

const NODE_W = 150;
const NODE_H = 34;
const GAP_X = 24;
const ROW_H = 84;
const PAD = 16;
const LABEL_MAX = 20;

// `more` entries are drawn as nodes of their own: under their parent, or, with
// no parent (lonely changed nodes), in the last layer.
function allNodes(slice) {
  const nodes = slice.nodes ?? [];
  const layerOf = new Map(nodes.map((node) => [node.id, node.layer ?? 0]));
  const last = nodes.reduce((max, node) => Math.max(max, node.layer ?? 0), 0);
  const extra = (slice.more ?? []).map((more) => ({
    id: more.id,
    more,
    layer: more.parent != null && layerOf.has(more.parent) ? layerOf.get(more.parent) + 1 : last,
  }));
  return [...nodes.map((node) => ({ id: node.id, node, layer: node.layer ?? 0 })), ...extra];
}

function allEdges(slice) {
  const edges = (slice.edges ?? []).map((edge) => ({ ...edge }));
  for (const more of slice.more ?? []) {
    if (more.parent != null) edges.push({ from: more.parent, to: more.id, type: 'call' });
  }
  return edges;
}

export function layoutSlice(slice, { width = 0, height = 0 } = {}) {
  const nodes = allNodes(slice ?? {});
  const edges = allEdges(slice ?? {});
  const layers = [];
  for (const node of nodes) (layers[node.layer] ??= []).push(node.id);
  const rows = [];
  for (let i = 0; i < layers.length; i += 1) if (layers[i]) rows.push(layers[i]);
  const rowIndex = new Map();
  rows.forEach((row, r) => row.forEach((id) => rowIndex.set(id, r)));

  const neighbours = new Map(nodes.map((node) => [node.id, { up: [], down: [] }]));
  for (const { from, to } of edges) {
    if (!neighbours.has(from) || !neighbours.has(to)) continue;
    if (rowIndex.get(from) < rowIndex.get(to)) {
      neighbours.get(to).up.push(from);
      neighbours.get(from).down.push(to);
    } else if (rowIndex.get(from) > rowIndex.get(to)) {
      neighbours.get(from).up.push(to);
      neighbours.get(to).down.push(from);
    }
  }
  // Two barycenter passes, top-down then bottom-up; a node with no neighbour on
  // that side keeps its current slot.
  const sweep = (r, side) => {
    const pos = new Map(rows[r].map((id, i) => [id, i]));
    const reference = new Map(rows[side === 'up' ? r - 1 : r + 1].map((id, i) => [id, i]));
    const key = (id) => {
      const near = neighbours.get(id)[side].filter((n) => reference.has(n));
      return near.length ? near.reduce((sum, n) => sum + reference.get(n), 0) / near.length : pos.get(id);
    };
    const keyed = rows[r].map((id) => [id, key(id), pos.get(id)]);
    keyed.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    rows[r] = keyed.map(([id]) => id);
  };
  for (let r = 1; r < rows.length; r += 1) sweep(r, 'up');
  for (let r = rows.length - 2; r >= 0; r -= 1) sweep(r, 'down');

  const widest = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const contentW = widest * NODE_W + Math.max(0, widest - 1) * GAP_X + PAD * 2;
  const total = Math.max(width, contentW);
  const positions = {};
  rows.forEach((row, r) => {
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    const start = (total - rowW) / 2;
    row.forEach((id, i) => { positions[id] = { x: start + i * (NODE_W + GAP_X), y: PAD + r * ROW_H }; });
  });
  return { positions, width: total, height: Math.max(height, PAD * 2 + Math.max(0, rows.length - 1) * ROW_H + NODE_H) };
}

const clip = (text) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

function renderEdge(edge, positions) {
  const a = positions[edge.from];
  const b = positions[edge.to];
  if (!a || !b) return '';
  const dash = edge.type === 'import' ? ' stroke-dasharray="5 4"' : '';
  const x1 = a.x + NODE_W / 2;
  const x2 = b.x + NODE_W / 2;
  const [y1, y2] = a.y <= b.y ? [a.y + NODE_H, b.y] : [a.y, b.y + NODE_H];
  return `<line class="edge edge-${escapeHtml(edge.type)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${dash} />`;
}

export function renderSlice(slice, layout, { selectedId = null } = {}) {
  const positions = layout.positions;
  const lines = allEdges(slice ?? {}).map((edge) => renderEdge(edge, positions)).join('');
  const boxes = [];
  for (const node of slice?.nodes ?? []) {
    const at = positions[node.id];
    if (!at) continue;
    const state = ['changed', 'affected', 'context'].includes(node.state) ? node.state : 'context';
    const selected = node.id === selectedId ? ' selected' : '';
    const badge = node.untested ? `<text class="slice-untested" x="${NODE_W - 6}" y="-4" text-anchor="end">sem teste</text>` : '';
    boxes.push(`<g class="slice-node state-${state}${selected}" data-node="${escapeHtml(node.id)}" transform="translate(${at.x} ${at.y})"><title>${escapeHtml(node.label)}</title><rect width="${NODE_W}" height="${NODE_H}" rx="6" /><text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle">${escapeHtml(clip(String(node.label ?? '')))}</text>${badge}</g>`);
  }
  for (const more of slice?.more ?? []) {
    const at = positions[more.id];
    if (!at) continue;
    const selected = more.id === selectedId ? ' selected' : '';
    boxes.push(`<g class="slice-node slice-more state-context${selected}" data-node="${escapeHtml(more.id)}" transform="translate(${at.x} ${at.y})"><rect width="${NODE_W}" height="${NODE_H}" rx="6" /><text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle">${escapeHtml(`+${more.count} outras funções`)}</text></g>`);
  }
  return `<svg class="slice-svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">${lines}${boxes.join('')}</svg>`;
}

export function renderSliceStatus(status) {
  if (status?.status === 'building') {
    const counted = status.total > 0 ? ` ${escapeHtml(status.done)}/${escapeHtml(status.total)} arquivos` : '';
    return `<p class="slice-status building">lendo o projeto…${counted}</p>`;
  }
  if (status?.status === 'unavailable') {
    return `<p class="slice-status unavailable">${escapeHtml(status.reason || 'impacto indisponível')}</p>`;
  }
  return '';
}
