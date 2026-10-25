#!/usr/bin/env node
// Standalone on purpose: Claude Code runs this before every Bash, edit and MCP
// tool call, and it must keep working with the Vizor closed (it is copied to
// ~/.config/vizor/guard/). Node builtins only, ALWAYS exit 0, and decisions go
// out only as the hook's JSON on stdout.

// --- Evaluator (pure) -------------------------------------------------------

const SEPARATORS = ['&&', '||', ';', '|', '\n'];
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Words of a shell segment with their offsets in it, quotes removed.
function words(text) {
  const result = [];
  let current = null;
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < text.length) current.text += text[++index];
      else current.text += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) result.push(current);
      current = null;
      continue;
    }
    if (!current) current = { text: '', start: index };
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\' && index + 1 < text.length) current.text += text[++index];
    else current.text += char;
  }
  if (current) result.push(current);
  return result;
}

// Top-level split on && || ; | and newlines, quotes respected.
function splitTopLevel(command) {
  const parts = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => command.startsWith(candidate, index));
    if (separator) {
      parts.push(command.slice(start, index));
      index += separator.length - 1;
      start = index + 1;
    }
  }
  parts.push(command.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function splitCommand(command) {
  if (typeof command !== 'string') return [];
  const segments = [];
  for (const part of splitTopLevel(command)) {
    const tokens = words(part);
    let first = 0;
    while (first < tokens.length) {
      const token = tokens[first].text;
      if (WRAPPERS.has(token) || ASSIGNMENT.test(token)) first++;
      else if (first > 0 && WRAPPERS.has(tokens[first - 1].text) && token.startsWith('-')) first++;
      else break;
    }
    if (first >= tokens.length) continue;
    const rest = tokens.slice(first);
    const dashC = rest.findIndex((token) => token.text === '-c');
    if (SHELLS.has(rest[0].text) && dashC > 0 && rest[dashC + 1]) {
      segments.push(...splitCommand(rest[dashC + 1].text));
      continue;
    }
    segments.push(part.slice(rest[0].start).trim());
  }
  return segments;
}

function branchName(ref) {
  return ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

export function parseGitAction(segment) {
  const tokens = words(segment).map((token) => token.text);
  if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'merge')
    return { action: 'pr-merge', target: null, force: false };
  if (tokens[0] !== 'git') return null;
  let index = 1;
  // Global options before the subcommand (-C dir, -c key=value).
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += tokens[index] === '-C' || tokens[index] === '-c' ? 2 : 1;
  }
  const sub = tokens[index];
  const args = tokens.slice(index + 1);
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (sub === 'push') {
    const force = args.some((arg) => arg === '-f' || arg === '--force' || arg.startsWith('--force-with-lease'));
    const refspec = positional.length > 1 ? positional[positional.length - 1] : null;
    if (!refspec) return { action: 'push', target: null, force };
    const destination = refspec.includes(':') ? refspec.split(':').pop() : refspec;
    const plusForced = refspec.startsWith('+');
    const target = destination === 'HEAD' ? null : branchName(destination);
    return { action: 'push', target, force: force || plusForced };
  }
  if (sub === 'merge') return { action: 'merge', target: null, force: false };
  if (sub === 'commit') return { action: 'commit', target: null, force: false };
  if (sub === 'reset' && args.includes('--hard')) return { action: 'reset-hard', target: null, force: false };
  if (sub === 'branch' && args.some((arg) => arg === '-D' || arg === '-d' || arg === '--delete'))
    return { action: 'branch-delete', target: positional[0] ?? null, force: args.includes('-D') };
  return null;
}

const regexCache = new Map();
function regex(source, flags) {
  const key = `${flags}:${source}`;
  if (!regexCache.has(key)) {
    try {
      regexCache.set(key, new RegExp(source, flags));
    } catch {
      regexCache.set(key, null);
    }
  }
  return regexCache.get(key);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWords(list) {
  const alternatives = list.filter((word) => typeof word === 'string' && word).map(escapeRegex);
  if (alternatives.length === 0) return null;
  return regex(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
}

function deepStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((inner) => deepStrings(inner, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((inner) => deepStrings(inner, out));
  return out;
}

function editPath(input) {
  return input?.file_path ?? input?.notebook_path ?? '';
}

function writtenTexts(input) {
  const texts = [input?.content, input?.new_string, input?.new_source];
  if (Array.isArray(input?.edits)) texts.push(...input.edits.map((edit) => edit?.new_string));
  return texts.filter((text) => typeof text === 'string');
}

function keywordTexts(call) {
  if (call.tool === 'Bash') return [call.input?.command ?? ''];
  if (EDIT_TOOLS.has(call.tool)) return [editPath(call.input), ...writtenTexts(call.input)];
  if (call.tool?.startsWith('mcp__')) return deepStrings(call.input);
  return [];
}

function sqlTexts(call) {
  if (call.tool === 'Bash') return [call.input?.command ?? ''];
  if (EDIT_TOOLS.has(call.tool)) return /\.sql$/i.test(editPath(call.input)) ? writtenTexts(call.input) : [];
  if (call.tool?.startsWith('mcp__')) return deepStrings(call.input);
  return [];
}

// Unknown facts count as matching: a guard that is unsure asks.
function gitTargetMatches(match, parsed, git) {
  const defaultBranch = git?.defaultBranch ?? 'main';
  const branch = parsed.target ?? (parsed.action === 'pr-merge' ? null : (git?.currentBranch ?? null));
  if (match.target === 'any' || match.target === undefined) return true;
  if (match.target === 'others') return git?.ownBranch !== true;
  const wanted = match.target === 'default' ? defaultBranch : match.target;
  return branch === null || branch === wanted;
}

function matchHits(match, call, git) {
  switch (match?.type) {
    case 'command': {
      if (call.tool !== 'Bash') return false;
      const pattern = regex(String(match.pattern ?? ''), 'i');
      return Boolean(pattern?.test(call.input?.command ?? ''));
    }
    case 'tool': {
      const pattern = regex(String(match.pattern ?? ''), 'i');
      return Boolean(pattern?.test(call.tool ?? ''));
    }
    case 'git': {
      if (call.tool !== 'Bash' || !Array.isArray(match.actions)) return false;
      return splitCommand(call.input?.command).some((segment) => {
        const parsed = parseGitAction(segment);
        if (!parsed || !match.actions.includes(parsed.action)) return false;
        if (match.force && !parsed.force) return false;
        return gitTargetMatches(match, parsed, git);
      });
    }
    case 'keyword': {
      const pattern = wholeWords(match.words ?? []);
      return Boolean(pattern) && keywordTexts(call).some((text) => pattern.test(text));
    }
    case 'sql': {
      const pattern = wholeWords(match.statements ?? []);
      return Boolean(pattern) && sqlTexts(call).some((text) => pattern.test(text));
    }
    default:
      return false;
  }
}

// The first forbid that matches, else the first ask; agent rules never match.
export function evaluate({ rules, call, git }) {
  let ask = null;
  for (const rule of rules ?? []) {
    if (rule?.kind !== 'forbid' && rule?.kind !== 'ask') continue;
    if (!(rule.match ?? []).some((match) => matchHits(match, call, git))) continue;
    if (rule.kind === 'forbid') return { rule, irreversible: Boolean(rule.irreversible) };
    ask ??= { rule, irreversible: Boolean(rule.irreversible) };
  }
  return ask;
}
