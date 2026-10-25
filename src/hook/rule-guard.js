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

// gitContext is lazy: git only runs when some rule needs it.
export async function decide({ event, rules, repoRoot, gitContext, ask, headless, notify = () => {} }) {
  const list = applicable(rules, repoRoot);
  const call = toolCall(event);
  const needsGit = list.some((rule) => (rule.match ?? []).some((match) => match?.type === 'git'));
  const git = needsGit ? gitContext() : null;
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

export function gitContextOf(cwd) {
  if (!cwd) return null;
  const currentBranch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!currentBranch) return null;
  const remoteHead = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = remoteHead ? remoteHead.replace(/^[^/]+\//, '') : 'main';
  const email = git(cwd, ['config', 'user.email']);
  let ownBranch = null;
  for (const base of [defaultBranch, `origin/${defaultBranch}`]) {
    const authors = git(cwd, ['log', '--format=%ae', `${base}..HEAD`]);
    if (authors === null) continue;
    const list = authors.split('\n').filter(Boolean);
    // Nothing of its own yet: the next commit makes it yours.
    ownBranch = email ? list.every((author) => author === email) : null;
    break;
  }
  return { currentBranch, defaultBranch, ownBranch };
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
        finish(answer === 'liberar' || answer === 'barrar' ? answer : 'timeout');
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
      gitContext: () => gitContextOf(event.cwd),
      ask: (request) => askVizor(request, waitMs),
      notify: tellVizor,
      headless: Boolean(entrypoint) && entrypoint !== 'cli',
    });
  }
  const context = contextFor({ event, rules, repoRoot, seenVersion: readSeen(event.session_id) });
  if (context) writeSeen(event.session_id, context.version);
  return context?.output ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
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
