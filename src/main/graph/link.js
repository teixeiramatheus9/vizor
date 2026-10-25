import path from 'node:path';

// The files' extracts, linked into the Maestro graph (#159): modules (files)
// grouped by folder, edges from relative imports, and calls resolved to the
// function they reach — local, named, default or through a namespace. What
// does not resolve (packages, dynamic calls, files outside the graph) is no
// edge. Pure.
const EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const TS_TWINS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

export function resolveImport(fromRel, specifier, known) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  if (base.startsWith('..')) return null;
  const candidates = [base, ...EXTENSIONS.map((extension) => base + extension), ...EXTENSIONS.map((extension) => `${base}/index${extension}`)];
  const extension = path.posix.extname(base);
  for (const twin of TS_TWINS[extension] ?? []) candidates.push(base.slice(0, -extension.length) + twin);
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

export function linkGraph(extracts) {
  const ids = [...extracts.keys()].sort();
  const known = new Set(ids);
  const functions = {};
  const modules = ids.map((id) => {
    const extract = extracts.get(id);
    for (const item of extract.functions) functions[item.id] = { module: id, name: item.name, startLine: item.startLine, endLine: item.endLine };
    return { id, group: path.posix.dirname(id), functions: extract.functions.map((item) => item.id) };
  });

  const moduleEdges = [];
  const callEdges = [];
  const seen = new Set();
  const edge = (list, from, to) => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    list.push({ from, to });
  };
  const fnIn = (module, name) => (functions[`${module}#${name}`] ? `${module}#${name}` : null);

  for (const id of ids) {
    const { imports, calls } = extracts.get(id);
    const bound = new Map(); // local name → { module, imported }
    for (const item of imports) {
      const target = resolveImport(id, item.from, known);
      if (!target) continue;
      edge(moduleEdges, id, target);
      if (item.local) bound.set(item.local, { module: target, imported: item.imported });
    }
    for (const { from, callee } of calls) {
      let to = null;
      if (callee.kind === 'local') {
        to = fnIn(id, callee.name);
        const via = !to && bound.get(callee.name);
        if (via && via.imported !== '*') to = fnIn(via.module, via.imported);
      } else if (callee.object) {
        const via = bound.get(callee.object);
        if (via?.imported === '*') to = fnIn(via.module, callee.name);
      } else {
        // this.helper(): a method of a class in the same file, when unique.
        const methods = Object.keys(functions).filter((fnId) => fnId.startsWith(`${id}#`) && fnId.endsWith(`.${callee.name}`));
        if (methods.length === 1) [to] = methods;
      }
      if (to) edge(callEdges, from, to);
    }
  }
  return { modules, moduleEdges, functions, callEdges };
}
