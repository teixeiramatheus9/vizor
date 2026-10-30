import fs from 'node:fs';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

// index.js is never loaded by the tests (it needs Electron), and node --check
// only sees syntax: a call to a name nobody declares or imports ships and
// fails live (live test: "claudeProjectDir is not defined" after a merge).
// This reads the file and checks every called name is bound somewhere in it.
const GLOBALS = new Set([
  'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Math', 'JSON', 'Date', 'Promise', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap',
  'Symbol', 'Buffer', 'URL', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'fetch', 'AbortController',
  'TextDecoder', 'TextEncoder', 'BigInt', 'Function', 'escape', 'unescape',
]);

function bindings(node, out) {
  if (!node || typeof node.type !== 'string') return;
  const bind = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') out.add(pattern.name);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((property) => bind(property.value ?? property.argument));
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(bind);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
    else if (pattern.type === 'RestElement') bind(pattern.argument);
  };
  if (node.type === 'VariableDeclarator') bind(node.id);
  if (/Function/.test(node.type)) {
    if (node.id) out.add(node.id.name);
    node.params.forEach(bind);
  }
  if (node.type === 'ClassDeclaration' && node.id) out.add(node.id.name);
  if (/^Import(Default|Namespace)?Specifier$/.test(node.type)) out.add(node.local.name);
  if (node.type === 'CatchClause') bind(node.param);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) value.forEach((child) => bindings(child, out));
    else bindings(value, out);
  }
}

function calls(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.callee?.type === 'Identifier') out.add(node.callee.name);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) value.forEach((child) => calls(child, out));
    else calls(value, out);
  }
}

describe('src/main/index.js', () => {
  it('every function it calls is declared or imported in it', () => {
    const ast = parse(fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8'), { sourceType: 'module' });
    const bound = new Set();
    const called = new Set();
    bindings(ast.program, bound);
    calls(ast.program, called);
    expect([...called].filter((name) => !bound.has(name) && !GLOBALS.has(name))).toEqual([]);
  });
});
