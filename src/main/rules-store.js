import path from 'node:path';
import { diffRules, ruleLines } from './rules-file.js';

// Approved rules go to compiladas.json, the only file the guard reads; drafts,
// the lines last seen and which repos were ever compiled live in
// rascunhos.json. Every write is tmp + rename, and the previous compiladas.json
// is kept as compiladas.anterior.json for the guard to fall back on.
const HISTORY_CAP = 200;

export function createRulesStore({ dir, readFile, writeFile, rename }) {
  const file = (name) => path.join(dir, name);

  function readJson(name, fallback) {
    try {
      return JSON.parse(readFile(file(name))) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeAtomic(name, content) {
    const target = file(name);
    writeFile(`${target}.tmp`, content);
    rename(`${target}.tmp`, target);
  }

  const compiledFile = readJson('compiladas.json', {});
  const draftsFile = readJson('rascunhos.json', {});
  let version = Number(compiledFile.version) || 0;
  let history = Array.isArray(readJson('historico.json', [])) ? readJson('historico.json', []) : [];

  // scope → { approved, drafts, lines, compiled }
  const scopes = new Map();
  function scopeOf(key) {
    if (!scopes.has(key)) scopes.set(key, { approved: [], drafts: [], lines: [], compiled: key === 'global' });
    return scopes.get(key);
  }
  scopeOf('global').approved = Array.isArray(compiledFile.global) ? compiledFile.global : [];
  for (const [root, list] of Object.entries(compiledFile.repos ?? {})) {
    const scope = scopeOf(root);
    scope.approved = Array.isArray(list) ? list : [];
    scope.compiled = true;
  }
  for (const [key, saved] of Object.entries(draftsFile.scopes ?? {})) {
    const scope = scopeOf(key);
    scope.drafts = Array.isArray(saved.drafts) ? saved.drafts : [];
    scope.lines = Array.isArray(saved.lines) ? saved.lines : [];
    scope.compiled = key === 'global' || Boolean(saved.compiled) || scope.compiled;
  }

  function saveDrafts() {
    const out = {};
    for (const [key, scope] of scopes) out[key] = { drafts: scope.drafts, lines: scope.lines, compiled: scope.compiled };
    writeAtomic('rascunhos.json', JSON.stringify({ scopes: out }, null, 2));
  }

  function saveCompiled() {
    version += 1;
    const repos = {};
    for (const [key, scope] of scopes) if (key !== 'global' && scope.compiled) repos[key] = scope.approved;
    try {
      const previous = readFile(file('compiladas.json'));
      writeAtomic('compiladas.anterior.json', previous);
    } catch {
      // first compile: nothing to keep
    }
    writeAtomic('compiladas.json', JSON.stringify({ version, global: scopeOf('global').approved, repos }, null, 2));
  }

  function pendingOf(scope) {
    const approved = new Set(scope.approved.map((rule) => rule.source));
    return scope.lines.filter((line) => !approved.has(line));
  }

  function view(scope) {
    return { approved: scope.approved, drafts: scope.drafts, pending: pendingOf(scope), compiled: scope.compiled };
  }

  return {
    snapshot() {
      const repos = {};
      for (const [key, scope] of scopes) if (key !== 'global') repos[key] = view(scope);
      return { version, global: view(scopeOf('global')), repos };
    },

    syncFile(key, markdown) {
      const scope = scopeOf(key);
      const lines = ruleLines(markdown);
      const result = diffRules({ lines, approved: scope.approved, drafts: scope.drafts });
      const approvalsChanged = result.active.length !== scope.approved.length;
      scope.lines = lines;
      scope.approved = result.active;
      scope.drafts = result.drafts;
      saveDrafts();
      if (approvalsChanged && scope.compiled) saveCompiled();
      return result.pending;
    },

    setDrafts(key, drafts) {
      const scope = scopeOf(key);
      const incoming = new Set(drafts.map((draft) => draft.source));
      scope.drafts = [...scope.drafts.filter((draft) => !incoming.has(draft.source)), ...drafts];
      scope.compiled = true;
      saveDrafts();
    },

    approve(key, ruleId, edited = null) {
      const scope = scopeOf(key);
      const draft = scope.drafts.find((candidate) => candidate.id === ruleId);
      if (!draft) return false;
      const rule = edited ? { ...draft, ...edited, id: draft.id, source: draft.source } : draft;
      scope.drafts = scope.drafts.filter((candidate) => candidate.id !== ruleId);
      scope.approved = [...scope.approved.filter((candidate) => candidate.source !== rule.source), rule];
      scope.compiled = true;
      saveDrafts();
      saveCompiled();
      return true;
    },

    discard(key, ruleId) {
      const scope = scopeOf(key);
      scope.drafts = scope.drafts.filter((candidate) => candidate.id !== ruleId);
      saveDrafts();
    },

    markSeenRepo(root) {
      if (!scopes.has(root)) {
        scopeOf(root);
        saveDrafts();
      }
    },

    addHistory(entry) {
      history = [...history, entry].slice(-HISTORY_CAP);
      writeAtomic('historico.json', JSON.stringify(history));
    },

    recentHistory(limit = 50) {
      return history.slice(-limit).reverse();
    },
  };
}
