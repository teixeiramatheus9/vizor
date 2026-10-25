#!/usr/bin/env node
// Standalone on purpose: Claude Code runs this before every Bash, edit and MCP
// tool call, and it must keep working with the Vizor closed (it is copied to
// ~/.config/vizor/guard/). Node builtins only, ALWAYS exit 0, and decisions go
// out only as the hook's JSON on stdout.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// --- Evaluator (pure) -------------------------------------------------------

const SEPARATORS = ['&&', '||', ';', '|&', '|', '&', '\n'];
// Wrappers that run the rest of the line; the value-taking options of each.
const WRAPPERS = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-U'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['nohup', new Set()],
  ['time', new Set()],
  ['exec', new Set(['-a'])],
  ['command', new Set()],
  ['nice', new Set(['-n'])],
  ['ionice', new Set(['-c', '-n'])],
  ['timeout', new Set(['-s', '-k'])],
  ['xargs', new Set(['-n', '-I', '-P', '-L', '-d', '-s', '-E', '-a'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
]);
// A wrapper's own positional argument before the command (timeout 60 …).
const WRAPPER_POSITIONAL = new Set(['timeout']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', '(', ')']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^(?:\d*|&)(?:>>?|<<?<?|>&|<&)/;
const BARE_REDIRECTION = /^(?:\d*|&)(?:>>?|<<?|>\||<>)$/;
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

// Redirections (2>&1, > /tmp/log, <in) are not arguments.
function withoutRedirections(tokens) {
  const kept = [];
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index].text ?? tokens[index];
    if (BARE_REDIRECTION.test(text)) {
      index++; // the file that follows
      continue;
    }
    if (REDIRECTION.test(text)) continue;
    kept.push(tokens[index]);
  }
  return kept;
}

// Top-level split on && || ; | & and newlines, quotes respected; `>&`, `&>`
// and `2>&1` are redirections, not separators.
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
    if (char === '&' && (command[index - 1] === '>' || command[index - 1] === '<' || command[index + 1] === '>')) continue;
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

// $(…) and `…` run too, even inside double quotes (not inside single ones).
function substitutions(command) {
  const found = [];
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === "'" && !quote) quote = "'";
    else if (char === '"') quote = quote === '"' ? null : '"';
    else if (char === '`') {
      const close = command.indexOf('`', index + 1);
      if (close === -1) break;
      found.push(command.slice(index + 1, close));
      index = close;
    } else if (char === '$' && command[index + 1] === '(' && command[index + 2] !== '(') {
      let depth = 0;
      let close = -1;
      for (let inner = index + 1; inner < command.length; inner++) {
        if (command[inner] === '(') depth++;
        else if (command[inner] === ')' && --depth === 0) {
          close = inner;
          break;
        }
      }
      if (close === -1) break;
      found.push(command.slice(index + 2, close));
      index = close;
    }
  }
  return found;
}

function unwrap(tokens) {
  let first = 0;
  while (first < tokens.length) {
    const token = tokens[first].text;
    if (KEYWORDS.has(token) || ASSIGNMENT.test(token)) {
      first++;
      continue;
    }
    const options = WRAPPERS.get(token);
    if (!options) break;
    first++;
    while (first < tokens.length && tokens[first].text.startsWith('-')) {
      first += options.has(tokens[first].text) ? 2 : 1;
    }
    if (WRAPPER_POSITIONAL.has(token)) first++;
  }
  return tokens.slice(first);
}

export function splitCommand(command, depth = 0) {
  if (typeof command !== 'string' || depth > 4) return [];
  const segments = [];
  for (const inner of substitutions(command)) segments.push(...splitCommand(inner, depth + 1));
  for (const raw of splitTopLevel(command)) {
    // Subshells and groups: ( … ) and { …; }
    const part = raw.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, '').trim();
    const rest = unwrap(words(part));
    if (rest.length === 0) continue;
    const dashC = rest.findIndex((token) => token.text === '-c');
    if (SHELLS.has(rest[0].text) && dashC > 0 && rest[dashC + 1]) {
      segments.push(...splitCommand(rest[dashC + 1].text, depth + 1));
      continue;
    }
    if (rest[0].text === 'eval') {
      segments.push(...splitCommand(rest.slice(1).map((token) => token.text).join(' '), depth + 1));
      continue;
    }
    segments.push(part.slice(rest[0].start).trim());
  }
  return segments;
}

// Directories as the command names them: '' = the session's cwd, null = one
// the guard cannot follow ($VAR, cd -). The caller resolves them.
const ABSOLUTE_DIR = /^(?:~|[A-Za-z]:)?[\\/]|^~$/;

function joinDir(base, next) {
  if (next === '') return base;
  if (base === null || typeof next !== 'string' || next === '-' || /[$`*?]/.test(next)) return null;
  if (ABSOLUTE_DIR.test(next) || base === '') return next;
  return `${base}/${next}`;
}

// Each git action in the command with every directory it may run in: the
// cwd plus each cd before it. A subshell or a failed cd can undo a cd, so all
// of them count — a guard that is unsure asks.
function gitActions(command) {
  const actions = [];
  const dirs = [''];
  let current = '';
  for (const segment of splitCommand(command)) {
    const tokens = withoutRedirections(words(segment)).map((token) => token.text);
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      const target = tokens.slice(1).find((token) => !token.startsWith('-') || token === '-') ?? '~';
      current = joinDir(current, target);
      if (!dirs.includes(current)) dirs.push(current);
      continue;
    }
    const parsed = parseGitAction(segment);
    if (parsed) actions.push({ parsed, dirs: dirs.map((dir) => joinDir(dir, parsed.dir)) });
  }
  return actions;
}

function branchName(ref) {
  return ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

// git's global options that take a value (git --git-dir .git push … is still
// a push).
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// A .git directory stands for the checkout around it; any other git dir (a
// bare repo) is where git runs.
function checkoutOf(gitDir) {
  if (gitDir === null) return null;
  if (gitDir === '.git') return '';
  const match = /^(.*)[\\/]\.git[\\/]?$/.exec(gitDir);
  if (!match) return gitDir;
  return match[1] === '' ? '/' : match[1];
}

// target: the branch named (null = the current one); targets: every branch a
// multi-refspec push names; unknown: the branch cannot be read from the line
// ($var, --all, gh pr merge) — a guard that is unsure asks.
export function parseGitAction(segment) {
  const tokens = withoutRedirections(words(segment)).map((token) => token.text);
  if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'merge')
    return { action: 'pr-merge', target: null, targets: [], force: false, unknown: true, dir: '' };
  if (tokens[0] !== 'git') return null;
  let index = 1;
  let cDir = ''; // git -C: relative to the shell's directory
  let workTree;
  let gitDir;
  // Global options before the subcommand; the value-taking ones come as
  // "--opt value" or "--opt=value", and must not be read as the subcommand.
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const token = tokens[index];
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!GIT_VALUE_OPTIONS.has(name)) {
      index += 1;
      continue;
    }
    const value = equals === -1 ? (tokens[index + 1] ?? null) : token.slice(equals + 1);
    index += equals === -1 ? 2 : 1;
    if (name === '-C') cDir = joinDir(cDir, value);
    else if (name === '--work-tree') workTree = value;
    else if (name === '--git-dir') gitDir = value;
  }
  // Where it runs: the work tree, else the checkout around the git dir.
  const place = workTree !== undefined ? workTree : gitDir !== undefined ? checkoutOf(gitDir) : '';
  const dir = joinDir(cDir, place);
  const sub = tokens[index];
  const args = tokens.slice(index + 1);
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const base = { targets: [], force: false, unknown: false, dir };
  if (sub === 'push') {
    const force = args.some((arg) => arg === '-f' || arg === '--force' || arg.startsWith('--force-with-lease'));
    const refspecs = positional.slice(1);
    const everything = args.some((arg) => arg === '--all' || arg === '--mirror' || arg === '--branches');
    const unknown = everything || refspecs.some((ref) => /[$`*]/.test(ref));
    const targets = refspecs.map((ref) => {
      const destination = ref.includes(':') ? ref.split(':').pop() : ref;
      return destination === 'HEAD' ? null : branchName(destination);
    });
    return {
      action: 'push',
      target: targets[0] ?? null,
      targets,
      force: force || refspecs.some((ref) => ref.startsWith('+')),
      unknown,
      dir,
    };
  }
  if (sub === 'merge') return { ...base, action: 'merge', target: null };
  if (sub === 'commit') return { ...base, action: 'commit', target: null };
  if (sub === 'reset' && args.includes('--hard')) return { ...base, action: 'reset-hard', target: null };
  if (sub === 'branch' && args.some((arg) => arg === '-D' || arg === '-d' || arg === '--delete'))
    return { ...base, action: 'branch-delete', target: positional[0] ?? null, force: args.includes('-D') };
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
  // `_` is a boundary on purpose: DB_PROD and PROD_URL name prod too.
  return regex(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
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

// Searching for or committing about a statement is not running it.
const SQL_QUIET_PROGRAMS = new Set(['grep', 'egrep', 'rg', 'ag', 'ack', 'git']);
const DB_TOOL = /sql|query|database|(^|_)db(_|$)|postgres|mysql|maria|supabase|mongo|redis|sqlite|neon|planetscale|prisma|bigquery|snowflake/i;

function sqlTexts(call) {
  if (call.tool === 'Bash')
    return splitCommand(call.input?.command).filter((segment) => !SQL_QUIET_PROGRAMS.has(words(segment)[0]?.text));
  if (EDIT_TOOLS.has(call.tool)) return /\.sql$/i.test(editPath(call.input)) ? writtenTexts(call.input) : [];
  if (call.tool?.startsWith('mcp__') && DB_TOOL.test(call.tool)) return deepStrings(call.input);
  return [];
}

// A statement, not the word: DROP TABLE x, TRUNCATE users — never "drop it".
const SQL_SHAPES = {
  DROP: 'DROP\\s+(?:TABLE|DATABASE|SCHEMA|VIEW|INDEX|COLUMN|USER|ROLE|TABLESPACE|SEQUENCE|FUNCTION|TRIGGER|TYPE|EXTENSION|MATERIALIZED|CONSTRAINT|IF\\s+EXISTS)',
  TRUNCATE: 'TRUNCATE\\s+(?:TABLE\\s+)?[\\w"`.]',
  DELETE: 'DELETE\\s+FROM',
};

function sqlPattern(statements) {
  const shapes = statements
    .filter((statement) => typeof statement === 'string' && statement)
    .map((statement) => SQL_SHAPES[statement.toUpperCase()] ?? `${escapeRegex(statement)}\\s+[\\w"\`.]`);
  return shapes.length ? regex(`\\b(?:${shapes.join('|')})\\b`, 'i') : null;
}

// Unknown facts count as matching: a guard that is unsure asks.
// gitAt() reads the repo's facts only when the target needs them.
function gitTargetMatches(match, parsed, gitAt) {
  if (match.target === 'any' || match.target === undefined) return true;
  const git = gitAt();
  if (match.target === 'others') return git?.ownBranch !== true;
  if (parsed.unknown) return true;
  const wanted = match.target === 'default' ? (git?.defaultBranch ?? 'main') : match.target;
  const named = parsed.targets.length ? parsed.targets : [parsed.target];
  return named.some((target) => {
    const branch = target ?? git?.currentBranch ?? null;
    return branch === null || branch === wanted;
  });
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
      // git: the facts of one repo, or dir → facts (dir as the command names
      // it, '' = the cwd, null = unknown).
      const contextAt = typeof git === 'function' ? git : () => git;
      return gitActions(call.input?.command).some(({ parsed, dirs }) => {
        if (!match.actions.includes(parsed.action)) return false;
        if (match.force && !parsed.force) return false;
        return dirs.some((dir) => gitTargetMatches(match, parsed, () => contextAt(dir)));
      });
    }
    case 'keyword': {
      const pattern = wholeWords(match.words ?? []);
      return Boolean(pattern) && keywordTexts(call).some((text) => pattern.test(text));
    }
    case 'sql': {
      const pattern = sqlPattern(match.statements ?? []);
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

// --- Decision ---------------------------------------------------------------

export const ASK_WAIT_MS = 540000; // under the hook's 600 s timeout
const CONNECT_TIMEOUT_MS = 300;
const GIT_TIMEOUT_MS = 1000;
const CONTEXT_CAP = 10000;

function validRules(parsed) {
  return parsed && typeof parsed === 'object' && Array.isArray(parsed.global) ? parsed : null;
}

export function loadRules(readFile, dir) {
  for (const name of ['compiladas.json', 'compiladas.anterior.json']) {
    try {
      const parsed = validRules(JSON.parse(readFile(path.join(dir, name))));
      if (parsed) return { version: parsed.version ?? 0, global: parsed.global, repos: parsed.repos ?? {} };
    } catch {
      // try the previous good copy
    }
  }
  return null;
}

function applicable(rules, repoRoot) {
  const repo = repoRoot && Array.isArray(rules.repos?.[repoRoot]) ? rules.repos[repoRoot] : [];
  return [...rules.global, ...repo];
}

function toolCall(event) {
  return { tool: event.tool_name ?? '', input: event.tool_input ?? {} };
}

// What a "liberar nesta sessão" grant is about: the branch, file or command.
function targetOf(call) {
  if (call.tool === 'Bash') {
    const command = String(call.input.command ?? '');
    const git = splitCommand(command).map(parseGitAction).find(Boolean);
    return git?.target ?? command;
  }
  if (EDIT_TOOLS.has(call.tool)) return editPath(call.input);
  return call.tool;
}

function deny(reason) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

// A directory as the command names it, made absolute against the session's.
function resolveDir(cwd, dir) {
  if (dir === null) return null;
  if (dir === '~' || dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(1));
  if (path.isAbsolute(dir)) return dir;
  return cwd ? path.resolve(cwd, dir) : null;
}

// gitContext(absoluteDir) runs only for a git action a rule looks at, once
// per directory; the facts themselves are read lazily (gitContextOf).
export async function decide({ event, rules, repoRoot, gitContext, ask, headless, notify = () => {} }) {
  const list = applicable(rules, repoRoot);
  const call = toolCall(event);
  const contexts = new Map();
  const git = (dir) => {
    const absolute = resolveDir(event.cwd, dir);
    if (absolute === null) return null;
    if (!contexts.has(absolute)) contexts.set(absolute, gitContext(absolute));
    return contexts.get(absolute);
  };
  const hit = evaluate({ rules: list, call, git });
  if (!hit) return null;
  const { rule } = hit;
  if (rule.kind === 'forbid') {
    const command = call.tool === 'Bash' ? String(call.input.command ?? '') : `${call.tool} ${editPath(call.input)}`.trim();
    notify({
      type: 'guard-event',
      sessionId: event.session_id ?? null,
      cwd: event.cwd ?? null,
      ruleSource: rule.source,
      outcome: 'barrado',
      summary: command.slice(0, 200),
    });
    const why = rule.explain ? `${rule.explain.replace(/[.!?]$/, '')}. ` : '';
    return deny(`Barrado pela regra do usuário: "${rule.source}". ${why}Não tente contornar.`);
  }
  const answer = await ask({
    type: 'guard-ask',
    sessionId: event.session_id ?? null,
    cwd: event.cwd ?? null,
    tool: call.tool,
    input: call.input,
    ruleId: rule.id,
    ruleSource: rule.source,
    explain: rule.explain ?? '',
    irreversible: hit.irreversible,
    target: targetOf(call),
  });
  if (answer === 'liberar') return null;
  if (answer === 'barrar')
    return deny(`Passo barrado no Vizor pelo usuário (regra: "${rule.source}"). Pergunte o que ele quer antes de seguir.`);
  if (answer === 'offline') {
    if (headless)
      return deny(`A regra do usuário pede confirmação ("${rule.source}"), mas esta é uma sessão sem terminal para perguntar.`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `Regra do usuário: "${rule.source}". Confirme antes de seguir.`,
      },
    };
  }
  return deny(`Passo parado: sem resposta no Vizor a tempo (regra: "${rule.source}"). Não tente de novo sem falar com o usuário.`);
}

const KIND_LABEL = { forbid: 'o Vizor barra', ask: 'o Vizor pergunta antes', agent: 'sem trava, só siga' };

export function contextFor({ event, rules, repoRoot, seenVersion }) {
  const name = event?.hook_event_name;
  if (name !== 'SessionStart' && name !== 'UserPromptSubmit') return null;
  if (name === 'UserPromptSubmit' && rules.version === seenVersion) return null;
  const list = applicable(rules, repoRoot);
  if (list.length === 0) return null;
  const head = 'Regras do usuário (Vizor): leia todas antes de qualquer ação e siga sempre.';
  let text = head;
  const cut = '\n… (há mais regras; peça a lista completa ao usuário)';
  for (const rule of list) {
    const line = `\n- ${rule.source} (${KIND_LABEL[rule.kind] ?? KIND_LABEL.agent})`;
    if (text.length + line.length + cut.length > CONTEXT_CAP) {
      text += cut;
      break;
    }
    text += line;
  }
  return { output: { hookSpecificOutput: { hookEventName: name, additionalContext: text } }, version: rules.version };
}

// --- Script entry -----------------------------------------------------------

// Mirrors configDir/managerSocketPath in src/main/paths.js (standalone file).
const configDir = path.join(os.homedir(), '.config', 'vizor');
const rulesDir = path.join(configDir, 'regras');
const socketPath =
  process.env.VIZOR_SOCKET ??
  (process.platform === 'win32'
    ? `\\\\.\\pipe\\vizor-${os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '-')}`
    : path.join(configDir, 'vizor.sock'));

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function repoRootOf(cwd) {
  const common = cwd ? git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : null;
  if (!common) return null;
  return common.endsWith(`${path.sep}.git`) ? path.dirname(common) : common;
}

// Each fact costs git processes (tens of ms in all), so each runs only when a
// rule reads it, and once. Outside a repo every fact is unknown (null), which
// the evaluator treats as matching.
export function gitContextOf(cwd, run = git) {
  if (!cwd) return null;
  const facts = new Map();
  const once = (name, read) => {
    if (!facts.has(name)) facts.set(name, read());
    return facts.get(name);
  };
  return {
    get currentBranch() {
      return once('currentBranch', () => run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null);
    },
    get defaultBranch() {
      return once('defaultBranch', () => {
        const remoteHead = run(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
        return remoteHead ? remoteHead.replace(/^[^/]+\//, '') : 'main';
      });
    },
    get ownBranch() {
      return once('ownBranch', () => {
        const defaultBranch = this.defaultBranch;
        const email = run(cwd, ['config', 'user.email']);
        if (!email) return null;
        for (const base of [defaultBranch, `origin/${defaultBranch}`]) {
          const authors = run(cwd, ['log', '--format=%ae', `${base}..HEAD`]);
          if (authors === null) continue;
          // Nothing of its own yet: the next commit makes it yours.
          return authors.split('\n').filter(Boolean).every((author) => author === email);
        }
        return null;
      });
    },
  };
}

function askVizor(request, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = net.connect(socketPath);
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(waitTimer);
      socket.destroy();
      resolve(answer);
    };
    const connectTimer = setTimeout(() => finish('offline'), CONNECT_TIMEOUT_MS);
    const waitTimer = setTimeout(() => finish('timeout'), waitMs);
    socket.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const { answer } = JSON.parse(buffer.slice(0, newline));
        // offline: the Vizor is quitting with the question open.
        finish(answer === 'liberar' || answer === 'barrar' || answer === 'offline' ? answer : 'timeout');
      } catch {
        finish('timeout');
      }
    });
    socket.on('error', () => finish(connected ? 'timeout' : 'offline'));
    socket.on('close', () => finish(connected ? 'timeout' : 'offline'));
  });
}

// Fire and forget, for the Vizor's history; nobody listening is fine.
let telling = Promise.resolve();
function tellVizor(note) {
  telling = new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, CONNECT_TIMEOUT_MS);
    socket.on('connect', () => socket.end(`${JSON.stringify(note)}\n`));
    socket.on('close', done);
    socket.on('error', done);
  });
}

function seenFile(sessionId) {
  return path.join(rulesDir, 'sessoes', String(sessionId).replace(/[^A-Za-z0-9-]/g, '') || 'sem-id');
}

function readSeen(sessionId) {
  try {
    return Number(fs.readFileSync(seenFile(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeSeen(sessionId, version) {
  try {
    fs.mkdirSync(path.dirname(seenFile(sessionId)), { recursive: true });
    fs.writeFileSync(seenFile(sessionId), String(version));
  } catch {
    // only costs a repeated context
  }
}

function print(output) {
  if (!output) process.exit(0);
  process.stdout.write(JSON.stringify(output), () => process.exit(0));
}

async function main(raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const rules = loadRules((file) => fs.readFileSync(file, 'utf8'), rulesDir);
  if (!rules) return null;
  const hasRepos = Object.keys(rules.repos).length > 0;
  const repoRoot = hasRepos ? repoRootOf(event.cwd) : null;
  if (event.hook_event_name === 'PreToolUse') {
    const waitMs = Number(process.env.VIZOR_GUARD_ASK_MS) || ASK_WAIT_MS;
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    return decide({
      event,
      rules,
      repoRoot,
      gitContext: (dir) => gitContextOf(dir),
      ask: (request) => askVizor(request, waitMs),
      notify: tellVizor,
      // claude -p and the Agent SDK (sdk-*) have nobody to ask; IDE
      // extensions do.
      headless: Boolean(entrypoint?.startsWith('sdk')),
    });
  }
  const context = contextFor({ event, rules, repoRoot, seenVersion: readSeen(event.session_id) });
  if (context) writeSeen(event.session_id, context.version);
  return context?.output ?? null;
}

// Also imported by the app's main process, where argv[1] is a flag
// (--no-sandbox) or nothing: only a real path to this very file runs it.
function runAsScript() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const waitMs = Number(process.env.VIZOR_GUARD_ASK_MS) || ASK_WAIT_MS;
  setTimeout(() => process.exit(0), waitMs + 20000);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    main(raw).then(
      (output) => telling.then(() => print(output)),
      () => process.exit(0),
    );
  });
}
