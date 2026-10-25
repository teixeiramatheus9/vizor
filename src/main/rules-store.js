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

  // Same fallback as the guard's loadRules: a corrupt file must not boot the
  // store empty (the next approve would then drop every earlier one).
  const parsesAsRules = (value) => value && typeof value === 'object' && Array.isArray(value.global);
  const mainCompiled = readJson('compiladas.json', null);
  const compiledFile = parsesAsRules(mainCompiled) ? mainCompiled : (readJson('compiladas.anterior.json', null) ?? {});
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
      // Only a good copy is worth keeping as the guard's fallback.
      if (parsesAsRules(JSON.parse(previous))) writeAtomic('compiladas.anterior.json', previous);
    } catch {
      // first compile, or a corrupt file: keep the fallback we have
    }
    writeAtomic('compiladas.json', JSON.stringify({ version, global: scopeOf('global').approved, repos }, null, 2));
  }

  function pendingOf(scope) {
    const approved = new Set(scope.approved.map((rule) => rule.source));
    return scope.lines.filter((line) => !approved.has(line));
  }

  const isOpenLine = (scope, source) => pendingOf(scope).includes(source);

  function view(scope) {
    return { approved: scope.approved, drafts: scope.drafts, pending: pendingOf(scope), compiled: scope.compiled };
  }

  return {
    snapshot() {
      const repos = {};
      for (const [key, scope] of scopes) if (key !== 'global') repos[key] = view(scope);
      return { version, global: view(scopeOf('global')), repos };
    },

    // null = the file is gone. A repo's rules stay as they were (a branch
    // switch must not cost a recompile); the global file counts as empty.
    syncFile(key, markdown) {
      if (markdown === null && key !== 'global') return pendingOf(scopeOf(key));
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

    // A compile can take a while: drafts for a line edited away (or approved)
    // meanwhile are stale and never offered (#165).
    setDrafts(key, compiled) {
      const scope = scopeOf(key);
      const drafts = compiled.filter((draft) => isOpenLine(scope, draft.source));
      const incoming = new Set(drafts.map((draft) => draft.source));
      scope.drafts = [...scope.drafts.filter((draft) => !incoming.has(draft.source)), ...drafts];
      scope.compiled = true;
      saveDrafts();
    },

    approve(key, ruleId, edited = null) {
      const scope = scopeOf(key);
      const draft = scope.drafts.find((candidate) => candidate.id === ruleId);
      if (!draft || !scope.lines.includes(draft.source)) return false;
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

    // A file the user starts from the rules screen is theirs: it never waits
    // for the "de fora" first compile (#165).
    markOwnedRepo(root) {
      const scope = scopeOf(root);
      if (scope.compiled) return;
      scope.compiled = true;
      saveDrafts();
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

// The guard keeps one sessoes/<id> file per session with the rules version it
// last showed it. Nothing ends a session for the guard, so the app sweeps the
// ones untouched for a week; a session still alive just gets its rules again.
export const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneSeenSessions({ dir, now, readdir, stat, unlink, maxAgeMs = SEEN_MAX_AGE_MS }) {
  let names;
  try {
    names = readdir(dir);
  } catch {
    return; // no folder yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = stat(file);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) unlink(file);
    } catch {
      // gone already, or not ours to read
    }
  }
}
