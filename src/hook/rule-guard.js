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

// --- Automações (VIZOR_AUTOMATION) ------------------------------------------
// An automação's `claude -p` carries VIZOR_AUTOMATION=<id>, and the Vizor
// writes what each id may do to <configDir>/automacoes/regras.json:
//   { "version": 1, "automations": { "<id>": { "id", "level",
//     "allowBash": [{ "program", "sub"?: [..], "argsPrefix"?: [..],
//       "extra"?: "any"|"none"|"after-dashdash", "requireArgs"?: [..],
//       "forbidArgs"?: [..] }],
//     "denyEdits": bool, "allowEditsUnder": "/abs/worktree" | null } } }
// An allowlist held before the user's rules: the guard denies whatever it
// cannot read exactly. It never normalizes a line to make it match.

const LEVEL_LABEL = { read: 'ler', worktree: 'worktree', project: 'projeto' };
const PLAIN_PROGRAM = /^[A-Za-z0-9._+-]+$/;
const WORD_CHAR = /[A-Za-z0-9_\-./:@%+=,^~]/;
const DEVICE = /^\/dev\/(?:null|stdout|stderr)$/;
const AUTOMATION_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Skill', 'LS', 'TodoWrite', 'Bash', ...EDIT_TOOLS]);

// The line as segments of words (quotes removed: { text, plain }), split on
// && || ; and |, with /dev/null-style redirections dropped; null for
// anything else: $, `, \, globs, braces, subshells, heredocs, other
// redirections, &, newlines, a dangling quote.
function plainLine(command) {
  if (typeof command !== 'string' || /[\n\r\0]/.test(command)) return null;
  const segments = [[]];
  let word = null;
  const endWord = () => {
    if (word) segments.at(-1).push(word);
    word = null;
  };
  const nextSegment = () => {
    endWord();
    segments.push([]);
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1);
      if (close === -1) return null;
      const inner = command.slice(index + 1, close);
      if (char === '"' && /[$`\\]/.test(inner)) return null;
      word ??= { text: '', plain: false };
      word.text += inner;
      word.plain = false;
      index = close;
    } else if (char === ' ' || char === '\t') endWord();
    else if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      nextSegment();
      index++;
    } else if (char === ';' || (char === '|' && next !== '&')) nextSegment();
    else if (word === null && (char === '>' || (/\d/.test(char) && next === '>'))) {
      // 2>&1, >&2, >/dev/null, 2>> /dev/null: nothing else
      let at = char === '>' ? index + 1 : index + 2;
      if (command[at] === '>') at++;
      if (command[at] === '&') {
        if (!/\d/.test(command[at + 1] ?? '') || WORD_CHAR.test(command[at + 2] ?? ' ')) return null;
        index = at + 1;
        continue;
      }
      while (command[at] === ' ') at++;
      let end = at;
      while (end < command.length && WORD_CHAR.test(command[end])) end++;
      if (!DEVICE.test(command.slice(at, end))) return null;
      // >/dev/null'x' writes to /dev/nullx: the sink must end the word.
      if (end < command.length && !/[\s;|&]/.test(command[end])) return null;
      index = end - 1;
    } else if (WORD_CHAR.test(char)) {
      // A leading ~ only as ~ or ~/…; inside a word only where bash keeps it
      // literal (HEAD~1), never after = or : where it may expand.
      if (char === '~' && word === null && next !== undefined && next !== '/' && WORD_CHAR.test(next)) return null;
      if (char === '~' && word !== null && /[=:]$/.test(word.text)) return null;
      word ??= { text: '', plain: true };
      word.text += char;
    } else return null;
  }
  endWord();
  return segments.every((segment) => segment.length > 0) ? segments : null;
}

const isFlag = (arg, flag) =>
  arg === flag || arg.startsWith(`${flag}=`) || (/^-[A-Za-z]$/.test(flag) && /^-[A-Za-z]+$/.test(arg) && arg.includes(flag[1]));

const GH_API_ENDPOINT = /^\/?[A-Za-z0-9._/-]{1,200}$/;

// gh api: only `gh api <endpoint>` plus --paginate, --jq/-q <expr> and
// -H 'Accept: …', each as its own word. pflag reads short clusters
// (-iXPUT, -ifbody=x), so any other option is denied, not parsed.
function ghApiReads(args) {
  let endpoint = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--paginate') continue;
    if (arg === '--jq' || arg === '-q') {
      if (args[++index] === undefined) return false;
    } else if (arg === '-H') {
      if (!/^accept:/i.test(args[++index] ?? '')) return false;
    } else if (arg.startsWith('-') || endpoint !== null) return false;
    else endpoint = arg;
  }
  // A path only: a query string, a host or an escape could carry data out.
  return endpoint !== null && GH_API_ENDPOINT.test(endpoint) && !/graphql/i.test(endpoint);
}

// git takes any unambiguous prefix of a long option (--outp = --output).
const GIT_BANNED_OPTIONS = ['--output', '--ext-diff', '--textconv'];
const GIT_KEPT_OPTIONS = new Set(['--text']); // an exact option of its own
function gitOptionBanned(arg) {
  const name = arg.split('=')[0];
  if (!name.startsWith('--') || name.length < 3 || GIT_KEPT_OPTIONS.has(name)) return false;
  return GIT_BANNED_OPTIONS.some((full) => full.startsWith(name));
}

// Options of an allowed program that would run or write something.
function argsSafe(program, args) {
  if (program === 'git') return !args.some(gitOptionBanned);
  if (program === 'rg') return !args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'));
  if (program === 'gh' && args[0] === 'api') return ghApiReads(args.slice(1));
  return true;
}

function entryMatches(entry, segment) {
  const texts = segment.map((word) => word.text);
  if (entry.program !== texts[0]) return false;
  let taken = 1;
  if (entry.sub) {
    if (!segment[1]?.plain || !entry.sub.includes(segment[1].text)) return false;
    taken = 2;
  }
  const prefix = entry.argsPrefix ?? [];
  if (!prefix.every((word, offset) => segment[taken + offset]?.plain && segment[taken + offset].text === word)) return false;
  const rest = texts.slice(taken + prefix.length);
  if (entry.extra === 'none' && rest.length) return false;
  if (entry.extra === 'after-dashdash' && rest.length && rest[0] !== '--') return false;
  if (entry.requireArgs && !rest.some((arg) => entry.requireArgs.some((flag) => isFlag(arg, flag)))) return false;
  if (entry.forbidArgs && rest.some((arg) => entry.forbidArgs.some((flag) => isFlag(arg, flag)))) return false;
  return argsSafe(entry.program, texts.slice(1));
}

function bashAllowed(rules, segments) {
  if (!segments) return false;
  return segments.every((segment) => {
    const [program] = segment;
    // FOO=1 cmd, /usr/bin/git, "git": not a plain program name
    if (!program.plain || !PLAIN_PROGRAM.test(program.text)) return false;
    return rules.allowBash.some((entry) => entryMatches(entry, segment));
  });
}

// The path a write lands on, symlinks followed, for a file that may not
// exist yet: the nearest existing ancestor is resolved and the rest joined.
function realTarget(file, links = 0) {
  try {
    return fs.realpathSync(file);
  } catch {
    // not there (yet), or a dangling link
  }
  if (links > 40) return null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return realTarget(path.resolve(path.dirname(file), fs.readlinkSync(file)), links + 1);
  } catch {
    // nothing at all there
  }
  const parent = path.dirname(file);
  if (parent === file) return file;
  const real = realTarget(parent, links);
  return real === null ? null : path.join(real, path.basename(file));
}

// Inside by path segments: /a/b-evil is not inside /a/b.
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

// Where a hook, a permission, a git hook or an alias could be rewritten.
function isProtected(file, home) {
  const parts = file.split(path.sep);
  // Git hooks (.git/hooks, husky, .githooks) run on the allowed commit.
  if (['.claude', '.git', '.husky', '.githooks'].some((name) => parts.includes(name))) return true;
  const roots = [
    path.join(home, '.config', 'vizor'),
    path.join(home, '.gitconfig'),
    path.join(home, '.config', 'git'),
    path.join(home, '.config', 'gh'),
    process.env.CLAUDE_CONFIG_DIR,
  ].filter(Boolean);
  return roots.some((root) => within(root, file) || within(realTarget(root) ?? root, file));
}

function editReason(rules, call, home) {
  if (rules.denyEdits || !rules.allowEditsUnder) return 'editar arquivos não é permitido neste nível';
  // One path per edit: a notebook's notebook_path, else file_path; two
  // different ones are refused rather than guessed.
  const named = [call.input?.notebook_path, call.input?.file_path].filter((value) => value !== undefined);
  if (named.length === 2 && named[0] !== named[1]) return 'edição com dois caminhos diferentes';
  const file = call.tool === 'NotebookEdit' ? (named[0] ?? '') : (call.input?.file_path ?? named[0] ?? '');
  // A path ending in / names a directory, never a file to write.
  const real = typeof file === 'string' && path.isAbsolute(file) && !/[\\/]$/.test(file) ? realTarget(path.resolve(file)) : null;
  if (real === null) return `edição fora do permitido para esta automação (${file})`;
  const root = realTarget(rules.allowEditsUnder) ?? rules.allowEditsUnder;
  if (!within(root, real)) return `editar fora da worktree da automação (${file})`;
  if (isProtected(real, home)) return `editar ${file} (configuração do Claude Code, do Vizor ou do git) nunca é permitido`;
  try {
    const stat = fs.statSync(real);
    // A hard link writes wherever its other names live.
    if (!stat.isFile() || stat.nlink !== 1) return `edição fora do permitido para esta automação (${file})`;
  } catch (error) {
    if (error?.code !== 'ENOENT') return `edição fora do permitido para esta automação (${file})`;
  }
  return null;
}

// Where keys and tokens live: never read by an automação, whatever its level.
const SECRET_PATHS = [
  '.ssh', '.gnupg', '.config/gh', '.aws', '.config/gcloud', '.kube',
  '.claude/.credentials.json', '.git-credentials', '.netrc', '.docker/config.json', '.npmrc', '.pypirc',
];
const SECRET_MESSAGE = 'Automação do Vizor: leitura de arquivo sensível barrada.';
const isEnvFile = (file) => /^\.env(?:\..+)?$/.test(path.basename(file));

function secretRoots(home) {
  const roots = SECRET_PATHS.map((name) => path.join(home, name));
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  return [...new Set(roots.flatMap((root) => [root, realTarget(root)]).filter(Boolean))];
}

// A word of the line (or an --opt=value) that names a secret, a .env file
// anywhere, or, for a recursive grep/rg, a directory holding a secret.
function readsSecret(segments, cwd, home) {
  const roots = secretRoots(home);
  return segments.some((segment) => {
    const [program, ...args] = segment.map((word) => word.text);
    if (program === 'grep' || program === 'rg') {
      // Searches that follow links, or read patterns from a file, can reach a
      // secret the words never name: deny them outright.
      const shorts = program === 'grep' ? 'Rf' : 'Lf';
      const banned = (arg) =>
        arg === '--file' || arg.startsWith('--file=') || arg === '--follow' ||
        (program === 'grep' && arg === '--dereference-recursive') ||
        (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--') && [...shorts].some((flag) => arg.includes(flag)));
      if (args.some(banned)) return true;
    }
    const recursive =
      program === 'rg' || (program === 'grep' && args.some((arg) => /^--(?:dereference-)?recursive$/.test(arg) || /^-[A-Za-z]*[rR]/.test(arg)));
    return args.some((arg) => {
      const value = arg.startsWith('-') ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '') : arg;
      if (!value) return false;
      let named = null;
      if (value === '~' || value.startsWith('~/')) named = path.join(home, value.slice(1));
      else if (path.isAbsolute(value)) named = path.resolve(value);
      else if (cwd) named = path.resolve(cwd, value);
      if (named === null) return false;
      const real = realTarget(named) ?? named;
      if (isEnvFile(named) || isEnvFile(real)) return true;
      return roots.some((root) => within(root, named) || within(root, real) || (recursive && (within(named, root) || within(real, root))));
    });
  });
}

// An automação whose rules could not be read (no file, corrupt, no entry for
// its id) may only read until the Vizor writes them: fail closed.
export const MISSING_AUTOMATION_RULES = Object.freeze({
  missing: true,
  level: '?',
  allowBash: [{ program: 'git', sub: ['status', 'log', 'diff', 'show'] }, ...['ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'pwd', 'echo'].map((program) => ({ program }))],
  denyEdits: true,
  allowEditsUnder: null,
});
const MISSING_MESSAGE = 'Automação do Vizor: não achei as regras desta automação; só leitura até o Vizor gravar as regras.';

// The deny reason for an automação's call, or null. Never throws: a call the
// guard fails to read is denied.
export function automationVerdict({ rules, call, cwd = null, home = os.homedir() }) {
  if (!rules) return null;
  let what = null;
  try {
    if (!AUTOMATION_TOOLS.has(call.tool)) what = `ferramenta ${call.tool} fora do permitido para esta automação`;
    else if (call.tool === 'Bash') {
      const segments = plainLine(call.input?.command);
      if (segments && readsSecret(segments, cwd, home)) return SECRET_MESSAGE;
      if (!bashAllowed(rules, segments)) what = 'comando fora do permitido para esta automação';
    } else if (EDIT_TOOLS.has(call.tool)) what = editReason(rules, call, home);
  } catch {
    what = 'um passo que a trava não conseguiu conferir';
  }
  if (!what) return null;
  if (rules.missing) return MISSING_MESSAGE;
  return `Automação do Vizor (nível ${LEVEL_LABEL[rules.level] ?? rules.level}): ${what}.`;
}

const stringList = (value) => (Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null);

// One allowBash entry, or null when any part of it is malformed.
function bashEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.program !== 'string' || !PLAIN_PROGRAM.test(raw.program)) return null;
  const entry = { program: raw.program };
  for (const key of ['sub', 'argsPrefix', 'requireArgs', 'forbidArgs']) {
    if (raw[key] === undefined) continue;
    if (!stringList(raw[key])) return null;
    entry[key] = [...raw[key]];
  }
  if (raw.extra !== undefined) {
    if (!['any', 'none', 'after-dashdash'].includes(raw.extra)) return null;
    entry.extra = raw.extra;
  }
  return entry;
}

// This automação's entry, normalized; null without one (the caller then
// holds the session to MISSING_AUTOMATION_RULES). A damaged entry fails
// closed: a bad allowBash item is dropped, a bad root means no edits.
export function loadAutomationRules(readFile, file, id) {
  if (typeof id !== 'string' || !id) return null;
  try {
    const parsed = JSON.parse(readFile(file));
    const all = parsed?.automations;
    if (!all || typeof all !== 'object' || Array.isArray(all) || !Object.hasOwn(all, id)) return null;
    const entry = all[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    let under = typeof entry.allowEditsUnder === 'string' && path.isAbsolute(entry.allowEditsUnder) ? path.resolve(entry.allowEditsUnder) : null;
    // The filesystem root or the home itself is never a worktree.
    if (under !== null && (path.parse(under).root === under || under === path.resolve(os.homedir()))) under = null;
    return {
      id,
      level: typeof entry.level === 'string' ? entry.level : '?',
      allowBash: Array.isArray(entry.allowBash) ? entry.allowBash.map(bashEntry).filter(Boolean) : [],
      denyEdits: entry.denyEdits !== false || under === null,
      allowEditsUnder: under,
    };
  } catch {
    return null;
  }
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
// automation: this automação's rules (loadAutomationRules), held before the
// user's; automationId goes with every question so the Vizor can tell.
export async function decide({ event, rules, repoRoot, gitContext, ask, headless, notify = () => {}, automation = null, automationId = null }) {
  const call = toolCall(event);
  const summary = () => (call.tool === 'Bash' ? String(call.input.command ?? '') : `${call.tool} ${editPath(call.input)}`.trim()).slice(0, 200);
  const barred = automationVerdict({ rules: automation, call, cwd: event.cwd ?? null });
  if (barred) {
    notify({
      type: 'guard-event',
      sessionId: event.session_id ?? null,
      cwd: event.cwd ?? null,
      ruleSource: barred,
      outcome: 'barrado',
      summary: summary(),
      automationId,
    });
    return deny(barred);
  }
  if (!rules) return null;
  const list = applicable(rules, repoRoot);
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
    notify({
      type: 'guard-event',
      sessionId: event.session_id ?? null,
      cwd: event.cwd ?? null,
      ruleSource: rule.source,
      outcome: 'barrado',
      summary: summary(),
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
    ...(automationId ? { automationId } : {}),
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
const automationsFile = path.join(configDir, 'automacoes', 'regras.json');
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
  const readFile = (file) => fs.readFileSync(file, 'utf8');
  // Only an automação's session reads its rules; one that cannot find them
  // may only read. Without the env, as before.
  const automationId = process.env.VIZOR_AUTOMATION || null;
  const automation =
    automationId && event.hook_event_name === 'PreToolUse'
      ? (loadAutomationRules(readFile, automationsFile, automationId) ?? MISSING_AUTOMATION_RULES)
      : null;
  const rules = loadRules(readFile, rulesDir);
  if (!rules && !automation) return null;
  const hasRepos = rules ? Object.keys(rules.repos).length > 0 : false;
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
      automation,
      automationId,
    });
  }
  if (!rules) return null;
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
