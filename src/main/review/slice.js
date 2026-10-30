// The change's slice of the project graph: the modules (or, expanded, the
// functions) around what the branch touched, callers above callees, at most
// `maxNodes` visible. Pure — the graph comes from linkGraph and the changed
// function ids from touchedFunctions.
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const HOP2 = 'hop2:';

export const isTestPath = (relPath) => TEST_PATH.test(relPath);

const fnModule = (graph, fnId) => graph.functions[fnId]?.module ?? null;

// Module → Map(neighbour → 'call'|'import'), one per direction, built once per
// call. A call between two files wins over the import that carries it.
function moduleAdjacency(graph) {
  const out = new Map();
  const into = new Map();
  for (const { id } of graph.modules) {
    out.set(id, new Map());
    into.set(id, new Map());
  }
  const link = (from, to, type) => {
    if (from === to || !out.has(from) || !out.has(to)) return;
    if (type === 'import' && out.get(from).has(to)) return;
    out.get(from).set(to, type);
    into.get(to).set(from, type);
  };
  for (const { from, to } of graph.moduleEdges) link(from, to, 'import');
  for (const { from, to } of graph.callEdges) link(fnModule(graph, from), fnModule(graph, to), 'call');
  return { out, into };
}

export function ubiquitous(graph, threshold = 15) {
  const callers = new Map(); // callee fnId → Set of caller modules
  for (const { from, to } of graph.callEdges) {
    const module = fnModule(graph, from);
    if (!module) continue;
    if (!callers.has(to)) callers.set(to, new Set());
    callers.get(to).add(module);
  }
  const found = new Set();
  for (const [fnId, modules] of callers) if (modules.size > threshold) found.add(fnId);
  return found;
}

export function untestedModules(graph) {
  const { out } = moduleAdjacency(graph);
  const tested = new Set();
  for (const { id } of graph.modules) {
    if (!isTestPath(id)) continue;
    for (const first of out.get(id).keys()) {
      tested.add(first);
      for (const second of out.get(first).keys()) tested.add(second);
    }
  }
  const untested = new Set();
  for (const { id } of graph.modules) if (!isTestPath(id) && !tested.has(id)) untested.add(id);
  return untested;
}

export function filesOfNode(graph, nodeId) {
  const fn = graph.functions[nodeId];
  if (fn) return { files: [fn.module], range: { startLine: fn.startLine, endLine: fn.endLine } };
  if (graph.modules.some((module) => module.id === nodeId)) return { files: [nodeId], range: null };
  return null;
}

// Layers by longest path from the callers. Back edges (found walking the ids in
// sorted order) are ignored, so a cycle gets the same layers every time.
function layerOf(ids, edges) {
  const sorted = [...ids].sort();
  const children = new Map(sorted.map((id) => [id, []]));
  for (const { from, to } of edges) children.get(from).push(to);
  for (const list of children.values()) list.sort();

  const state = new Map(); // id → 1 on the stack, 2 done
  const order = []; // post-order
  const backEdges = new Set();
  for (const root of sorted) {
    if (state.has(root)) continue;
    state.set(root, 1);
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack.at(-1);
      const [id, index] = top;
      const next = children.get(id)[index];
      if (next === undefined) {
        state.set(id, 2);
        order.push(id);
        stack.pop();
        continue;
      }
      top[1] += 1;
      if (state.get(next) === 1) backEdges.add(`${id}>${next}`);
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  const layer = new Map(sorted.map((id) => [id, 0]));
  for (const id of order.reverse()) {
    for (const child of children.get(id)) {
      if (backEdges.has(`${id}>${child}`)) continue;
      layer.set(child, Math.max(layer.get(child), layer.get(id) + 1));
    }
  }
  return layer;
}

export function egoSlice(graph, changedFnIds, { expanded = [], hops = 1, showHidden = false, maxNodes = 20 } = {}) {
  const changedFns = new Set(changedFnIds.filter((fnId) => graph.functions[fnId]));
  const changedModules = new Set([...changedFns].map((fnId) => fnModule(graph, fnId)));
  if (!changedModules.size) return { nodes: [], edges: [], more: [] };

  const { out, into } = moduleAdjacency(graph);
  const hidden = new Set();
  if (!showHidden) {
    for (const fnId of ubiquitous(graph)) hidden.add(fnModule(graph, fnId));
    for (const { id } of graph.modules) if (isTestPath(id)) hidden.add(id);
  }
  const visible = (id) => changedModules.has(id) || !hidden.has(id);

  // Which modules are in the slice, and how far from the change.
  const distance = new Map([...changedModules].map((id) => [id, 0]));
  const grow = (from, nextDistance) => {
    const added = [];
    for (const side of [out.get(from), into.get(from)]) {
      for (const id of side.keys()) {
        if (distance.has(id) || !visible(id)) continue;
        distance.set(id, nextDistance);
        added.push(id);
      }
    }
    return added;
  };
  let frontier = [...changedModules].sort();
  for (let hop = 1; hop <= hops; hop += 1) frontier = frontier.flatMap((id) => grow(id, hop));
  for (const item of expanded) {
    if (!item.startsWith(HOP2)) continue;
    const target = item.slice(HOP2.length);
    const module = graph.functions[target] ? fnModule(graph, target) : target;
    if (distance.has(module)) grow(module, hops + 1);
  }
  const stateOf = (module) => (changedModules.has(module) ? 'changed' : distance.get(module) === 1 ? 'affected' : 'context');

  // Expanded modules show their functions that matter here: the changed ones
  // and those that talk to another module of the slice.
  const expandedModules = new Set(expanded.filter((id) => distance.has(id)));
  const shownFns = new Map(); // module → [fnId] in graph order
  const touching = new Set();
  if (expandedModules.size) {
    for (const { from, to } of graph.callEdges) {
      const a = fnModule(graph, from);
      const b = fnModule(graph, to);
      if (a === b || !distance.has(a) || !distance.has(b)) continue;
      touching.add(from);
      touching.add(to);
    }
    for (const id of expandedModules) {
      const fns = graph.modules.find((module) => module.id === id).functions.filter((fnId) => changedFns.has(fnId) || touching.has(fnId));
      if (fns.length) shownFns.set(id, fns);
    }
  }
  const endpoint = (module, fnId) => (shownFns.has(module) ? (fnId && shownFns.get(module).includes(fnId) ? fnId : shownFns.get(module)[0]) : module);

  const nodes = new Map();
  const addNode = (id, kind, label, state, module) => nodes.set(id, { id, kind, label, state, untested: false, layer: 0, module });
  for (const module of distance.keys()) {
    if (!shownFns.has(module)) addNode(module, 'module', module, stateOf(module), module);
    else for (const fnId of shownFns.get(module)) addNode(fnId, 'function', graph.functions[fnId].name, changedFns.has(fnId) ? 'changed' : stateOf(module), module);
  }

  const edges = new Map();
  const addEdge = (from, to, type) => {
    const key = `${from}>${to}`;
    if (from !== to && !(edges.get(key)?.type === 'call')) edges.set(key, { from, to, type });
  };
  for (const [from, targets] of out) {
    if (!distance.has(from)) continue;
    for (const [to, type] of targets) {
      if (!distance.has(to)) continue;
      if (!shownFns.has(from) && !shownFns.has(to)) addEdge(from, to, type);
      else if (type === 'import') addEdge(endpoint(from), endpoint(to), 'import');
    }
  }
  // Calls between functions, when either end of the call is expanded.
  if (expandedModules.size) {
    for (const { from, to } of graph.callEdges) {
      const a = fnModule(graph, from);
      const b = fnModule(graph, to);
      if (!distance.has(a) || !distance.has(b)) continue;
      if (!shownFns.has(a) && !shownFns.has(b)) continue;
      if (shownFns.has(a) && !nodes.has(from)) continue;
      if (shownFns.has(b) && !nodes.has(to)) continue;
      addEdge(shownFns.has(a) ? from : a, shownFns.has(b) ? to : b, 'call');
    }
  }

  // Past the limit: the least connected context, then affected, collapse into
  // one "more" per parent. Changed ones stay; if they alone are too many the
  // least connected of them are the excess.
  const degree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const { from, to } of edges.values()) {
    degree.set(from, degree.get(from) + 1);
    degree.set(to, degree.get(to) + 1);
  }
  const removed = new Set();
  if (nodes.size > maxNodes) {
    const rank = (state) => (state === 'context' ? 0 : state === 'affected' ? 1 : 2);
    const order = [...nodes.values()].sort((a, b) => rank(a.state) - rank(b.state) || degree.get(a.id) - degree.get(b.id) || (a.id < b.id ? -1 : 1));
    for (const node of order.slice(0, nodes.size - maxNodes)) removed.add(node.id);
  }
  const parentOf = new Map();
  const neighbours = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const { from, to } of edges.values()) {
    neighbours.get(from).push(to);
    neighbours.get(to).push(from);
  }
  const pending = [...removed].sort();
  const rankKept = (id) => (nodes.get(id).state === 'changed' ? 0 : 1);
  for (const id of pending) {
    const kept = neighbours.get(id).filter((other) => !removed.has(other)).sort((a, b) => rankKept(a) - rankKept(b) || (a < b ? -1 : 1));
    if (kept.length) parentOf.set(id, kept[0]);
  }
  // Removed nodes that only touch removed ones follow their neighbour's parent.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of pending) {
      if (parentOf.has(id)) continue;
      const via = neighbours.get(id).find((other) => parentOf.has(other));
      if (via) {
        parentOf.set(id, parentOf.get(via));
        changed = true;
      }
    }
  }
  const more = new Map();
  for (const id of pending) {
    const parent = parentOf.get(id) ?? null;
    if (!more.has(parent)) more.set(parent, { id: `more:${parent ?? ''}`, parent, count: 0, ids: [] });
    const entry = more.get(parent);
    entry.ids.push(id);
    entry.count += 1;
  }

  const keptIds = [...nodes.keys()].filter((id) => !removed.has(id));
  const keptEdges = [...edges.values()].filter(({ from, to }) => !removed.has(from) && !removed.has(to));
  const layers = layerOf(keptIds, keptEdges);
  const untested = untestedModules(graph);
  return {
    nodes: keptIds.sort().map((id) => {
      const { module, ...node } = nodes.get(id);
      // filesOfNode rides along: a click on the node filters Mudanças by it.
      return { ...node, untested: untested.has(module), layer: layers.get(id), ...filesOfNode(graph, id) };
    }),
    edges: keptEdges,
    more: [...more.values()],
  };
}
