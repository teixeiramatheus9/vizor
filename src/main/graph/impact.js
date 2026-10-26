import path from 'node:path';
import { diffHunks } from '../edit-hunks.js';

// What a músico touched and what it plans to touch, on the Maestro graph
// (#159). Touched: the lines that changed since the task began, on the
// CURRENT version of the file, matched to the narrowest function holding
// them. Planned: the "Vizor-plano:" line the músico writes when it declares
// its plan. Pure.

function narrowest(graph, relPath, line) {
  let best = null;
  for (const fnId of graph.modules.find((module) => module.id === relPath)?.functions ?? []) {
    const fn = graph.functions[fnId];
    if (line < fn.startLine || line > fn.endLine) continue;
    if (!best || fn.endLine - fn.startLine < graph.functions[best].endLine - graph.functions[best].startLine) best = fnId;
  }
  return best;
}

export function touchedFunctions(graph, relPath, startText, currentText) {
  const module = graph.modules.find((item) => item.id === relPath);
  if (!module) return [];
  if (startText === null || startText === undefined) return [...module.functions];
  const diff = diffHunks(startText, currentText ?? '');
  if (!diff) return [];
  const hit = new Set();
  for (const { newStart, newLines } of diff.hunks) {
    const lines = newLines > 0 ? Array.from({ length: newLines }, (_, index) => newStart + index) : [Math.max(1, newStart)];
    for (const line of lines) {
      const fnId = narrowest(graph, relPath, line);
      if (fnId) hit.add(fnId);
    }
  }
  return module.functions.filter((fnId) => hit.has(fnId));
}

const PLAN_LINE = /^[ \t>*-]*`?Vizor-plano:`?\s*(.*)$/gim;

export function parsePlan(text, root) {
  const matches = [...String(text ?? '').matchAll(PLAN_LINE)];
  if (!matches.length) return [];
  const items = matches.at(-1)[1].split(',');
  const plan = [];
  for (const raw of items) {
    const item = raw.trim().replace(/^[`'"]+|[`'".]+$/g, '');
    if (!item) continue;
    const [file, fn = null] = item.split('#');
    let relPath = file;
    if (path.isAbsolute(file)) relPath = path.relative(root, file);
    relPath = path.posix.normalize(relPath.split(path.sep).join('/'));
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue;
    plan.push({ module: relPath, fn: fn || null });
  }
  return plan;
}

export function impactOf(graph, { touched = [], touchedModules = [], planned = [] }) {
  const moduleIds = new Set(graph.modules.map((module) => module.id));
  const modules = {};
  const functions = {};
  for (const relPath of touchedModules) if (moduleIds.has(relPath)) modules[relPath] = 'touched';
  for (const fnId of touched) {
    if (!graph.functions[fnId]) continue;
    functions[fnId] = 'touched';
    modules[graph.functions[fnId].module] = 'touched';
  }
  for (const { module, fn } of planned) {
    if (!moduleIds.has(module)) continue;
    if (fn) {
      const fnId = `${module}#${fn}`;
      if (!graph.functions[fnId]) continue;
      functions[fnId] ??= 'planned';
    }
    modules[module] ??= 'planned';
  }
  return { modules, functions };
}
