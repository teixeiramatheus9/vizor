import { parse } from '@babel/parser';

// One JS/TS file, read for the Maestro graph (#159): its functions with their
// lines, its imports and the calls each function makes. Pure; the indexer
// runs it in a worker. Anonymous functions (callbacks) belong to the named
// function around them; code outside any function is the "<topo>".
const TOP = '<topo>';
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'tokens']);

function pluginsFor(relPath) {
  if (/\.tsx$/.test(relPath)) return ['typescript', 'jsx'];
  if (/\.(ts|mts|cts)$/.test(relPath)) return ['typescript'];
  return ['jsx'];
}

const keyName = (key) => (key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : key?.type === 'PrivateName' ? `#${key.id?.name ?? key.name}` : null);
const isFunction = (node) => node && /^(ArrowFunctionExpression|FunctionExpression)$/.test(node.type);

export function extractFile(source, relPath) {
  const text = String(source ?? '');
  const lineCount = text.split('\n').length;
  const top = { id: `${relPath}#${TOP}`, name: TOP, startLine: 1, endLine: lineCount };
  const empty = (error) => ({ functions: [top], imports: [], calls: [], error });

  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: pluginsFor(relPath) });
  } catch (error) {
    return empty(String(error?.message ?? error));
  }
  if (ast.errors?.length) return empty(String(ast.errors[0]?.message ?? 'syntax error'));

  const functions = [top];
  const imports = [];
  const calls = [];
  const seenCalls = new Set();
  const stack = [top.id];

  const addFunction = (name, node) => {
    const id = `${relPath}#${name}`;
    if (!functions.some((item) => item.id === id)) functions.push({ id, name, startLine: node.loc.start.line, endLine: node.loc.end.line });
    return id;
  };
  const addCall = (callee) => {
    const from = stack.at(-1);
    const key = `${from}|${callee.kind}|${callee.object ?? ''}|${callee.name}`;
    if (seenCalls.has(key)) return;
    seenCalls.add(key);
    calls.push({ from, callee });
  };

  // The name a function node gets from where it sits, or null (a callback).
  function nameOf(node, parent, className) {
    if (node.type === 'FunctionDeclaration') return node.id?.name ?? (parent?.type === 'ExportDefaultDeclaration' ? 'default' : null);
    if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') return className ? `${className}.${keyName(node.key)}` : keyName(node.key);
    if (isFunction(node)) {
      if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
      if (parent?.type === 'ClassProperty' || parent?.type === 'ClassPrivateProperty') return className ? `${className}.${keyName(parent.key)}` : keyName(parent.key);
      if (parent?.type === 'ExportDefaultDeclaration') return 'default';
    }
    return null;
  }

  function visit(node, parent, className) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers ?? []) {
        const imported =
          specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : keyName(specifier.imported);
        imports.push({ local: specifier.local.name, imported, from: node.source.value });
      }
      return;
    }
    // CommonJS: const x = require('./y') / const { a } = require('./y')
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && node.init.callee?.name === 'require') {
      const from = node.init.arguments?.[0]?.value;
      if (typeof from === 'string') {
        if (node.id.type === 'Identifier') imports.push({ local: node.id.name, imported: 'default', from });
        else if (node.id.type === 'ObjectPattern')
          for (const property of node.id.properties ?? [])
            if (property.type === 'ObjectProperty' && property.value?.type === 'Identifier')
              imports.push({ local: property.value.name, imported: keyName(property.key), from });
      }
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && callee.name !== 'require') addCall({ kind: 'local', name: callee.name });
      else if ((callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') && !callee.computed && keyName(callee.property)) {
        const call = { kind: 'member', name: keyName(callee.property) };
        if (callee.object?.type === 'Identifier') call.object = callee.object.name;
        addCall(call);
      }
    }
    const nextClass = node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ? node.id?.name ?? className : className;
    const name = /Function|ClassMethod|ClassPrivateMethod/.test(node.type) ? nameOf(node, parent, className) : null;
    if (name) stack.push(addFunction(name, node));
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key) || !value || typeof value !== 'object') continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node, nextClass);
      else visit(value, node, nextClass);
    }
    if (name) stack.pop();
  }

  visit(ast.program, null, null);
  return { functions, imports, calls, error: null };
}
