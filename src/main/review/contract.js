import { parse } from '@babel/parser';
import { pluginsFor } from '../graph/extract.js';

// Contract changes of a file (exports, signatures, types, package deps,
// schema paths) spotted from two texts, without AI. Pure: the review service
// feeds it the merge-base text and the current text.

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const isFn = (n) => n && /^(ArrowFunctionExpression|FunctionExpression|FunctionDeclaration)$/.test(n.type);

// Entries are { sig, type } so a changed export can be told apart as a type
// change or a signature change.
function entriesOf(source, relPath) {
  const text = String(source ?? '');
  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: pluginsFor(relPath) });
  } catch {
    return null;
  }
  if (ast.errors?.length) return null;

  const slice = (n) => text.slice(n.start, n.end);
  const fnSig = (name, fn) => {
    const params = fn.params.map((p) => norm(slice(p))).join(', ');
    const ret = fn.returnType ? `: ${norm(slice(fn.returnType)).replace(/^:\s*/, '')}` : '';
    return `${name}(${params})${ret}`;
  };
  const out = new Map();
  const put = (name, sig, type = false) => out.set(name, { sig, type });

  for (const node of ast.program.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      put('default', isFn(d) ? fnSig('default', d) : 'value');
    } else if (node.type === 'ExportNamedDeclaration') {
      const d = node.declaration;
      if (!d) {
        for (const s of node.specifiers ?? []) {
          const exported = s.exported?.name ?? s.exported?.value;
          if (exported) put(exported, 'value');
        }
      } else if (d.type === 'FunctionDeclaration' && d.id) {
        put(d.id.name, fnSig(d.id.name, d));
      } else if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) {
          if (v.id.type !== 'Identifier') continue;
          put(v.id.name, isFn(v.init) ? fnSig(v.id.name, v.init) : 'value');
        }
      } else if (d.type === 'TSTypeAliasDeclaration' || d.type === 'TSInterfaceDeclaration') {
        put(d.id.name, norm(slice(d)), true);
      } else if (d.id?.name) {
        put(d.id.name, 'value');
      }
    }
  }
  return out;
}

export function exportsOf(source, relPath) {
  const entries = entriesOf(source, relPath);
  if (!entries) return null;
  return new Map([...entries].map(([name, e]) => [name, e.sig]));
}

export function contractChanges({ relPath, before, after }) {
  if (before == null || after == null) return [];
  const a = entriesOf(before, relPath);
  const b = entriesOf(after, relPath);
  if (!a || !b) return [];
  const changes = [];
  for (const [name, old] of a) {
    const now = b.get(name);
    if (!now) changes.push({ kind: 'removed', name, before: old.sig, after: null });
    else if (now.sig !== old.sig) changes.push({ kind: old.type || now.type ? 'type' : 'signature', name, before: old.sig, after: now.sig });
  }
  return changes;
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies'];

function depsOf(text) {
  try {
    const json = JSON.parse(text);
    const out = new Map();
    for (const key of DEP_KEYS) for (const [n, v] of Object.entries(json?.[key] ?? {})) out.set(n, String(v));
    return out;
  } catch {
    return null;
  }
}

export function packageChanges(beforeText, afterText) {
  const a = depsOf(beforeText);
  const b = depsOf(afterText);
  if (!a || !b) return [];
  const changes = [];
  for (const [name, v] of b) {
    if (!a.has(name)) changes.push({ kind: 'dep-added', name, before: null, after: v });
    else if (a.get(name) !== v) changes.push({ kind: 'dep-version', name, before: a.get(name), after: v });
  }
  for (const [name, v] of a) if (!b.has(name)) changes.push({ kind: 'dep-removed', name, before: v, after: null });
  const order = { 'dep-version': 0, 'dep-removed': 1, 'dep-added': 2 };
  return changes.sort((x, y) => order[x.kind] - order[y.kind]);
}

export function isSchemaPath(relPath) {
  return /(^|\/)migrations\//.test(relPath) || /\.sql$/.test(relPath) || /(^|\/)prisma\/schema\.prisma$/.test(relPath);
}
