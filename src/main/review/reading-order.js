// The order to read the changed files in: contract changes first (they ripple),
// then code, with tests and styles/docs last. Pure.
import { isTestPath } from './slice.js';

const STYLE_OR_DOC = /\.(css|scss|md)$/;

// How many other changed files call into each changed file.
function callerCounts(files, graph) {
  const changed = new Set(files.map((f) => f.path));
  const callers = new Map();
  for (const { from, to } of graph.callEdges) {
    const fromModule = graph.functions[from]?.module;
    const toModule = graph.functions[to]?.module;
    if (!changed.has(fromModule) || !changed.has(toModule) || fromModule === toModule) continue;
    if (!callers.has(toModule)) callers.set(toModule, new Set());
    callers.get(toModule).add(fromModule);
  }
  return (path) => callers.get(path)?.size ?? 0;
}

export function readingOrder(files, { graph = null, contractPaths = [] } = {}) {
  const contract = new Set(contractPaths);
  const count = graph ? callerCounts(files, graph) : () => 0;
  const rank = (f) => {
    if (contract.has(f.path)) return 0;
    if (isTestPath(f.path) || STYLE_OR_DOC.test(f.path)) return 2;
    return 1;
  };
  return [...files].sort((a, b) =>
    rank(a) - rank(b) || count(b.path) - count(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
