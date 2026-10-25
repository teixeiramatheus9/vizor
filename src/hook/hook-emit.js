#!/usr/bin/env node
// Standalone on purpose: Claude Code runs this on every hook event, so it
// must start fast, never block, and ALWAYS exit 0.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The legacy env name stays accepted: a `claude -p` spawned by an old
// claude-manager build still running would otherwise loop through this hook.
if (process.env.VIZOR_INTERNAL === '1' || process.env.CLAUDE_MANAGER_INTERNAL === '1')
  process.exit(0);

const socketPath =
  process.env.VIZOR_SOCKET ??
  (process.platform === 'win32'
    ? // must mirror managerSocketPath() in src/main/paths.js (standalone file,
      // no imports allowed)
      `\\\\.\\pipe\\vizor-${os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '-')}`
    : path.join(os.homedir(), '.config', 'vizor', 'vizor.sock'));

// Hard safety net: whatever happens, get out of Claude Code's way.
setTimeout(() => process.exit(0), 3000);

function fallbackNotify(event) {
  const eventName = event?.hook_event_name;
  if (eventName !== 'Stop' && eventName !== 'Notification') return;
  if (process.platform === 'win32') return; // no fast CLI notifier — stay silent
  const projectName = event?.cwd ? path.basename(event.cwd) : 'uma sessão';
  const body =
    eventName === 'Stop'
      ? `A tarefa do '${projectName}' terminou.`
      : (event?.message ?? `O '${projectName}' está esperando você.`);
  try {
    const [command, args] =
      process.platform === 'darwin'
        ? ['osascript', ['-e', `display notification ${JSON.stringify(body)} with title "Vizor"`]]
        : ['notify-send', ['Vizor', body]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // missing binary must never break exit 0
    child.unref();
  } catch {
    // no notifier available, nothing else to do
  }
}

// Edit-tool events carry whole file contents (Write) and tool output. The app
// reads every file from disk anyway, so megabytes over the socket on each
// edit would buy nothing but a slower hook.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const MAX_TOOL_STRING = 65536;

function truncateLargeStrings(value) {
  if (typeof value === 'string')
    return value.length > MAX_TOOL_STRING ? { truncated: value.length } : value;
  if (Array.isArray(value)) return value.map(truncateLargeStrings);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, truncateLargeStrings(inner)]),
    );
  return value;
}

function slimToolEvent(event) {
  const { tool_response: response, ...rest } = event;
  // Write reports whether it created the file: the one bit of the response
  // the app needs (a new file diffs against empty).
  if (response?.type === 'create' || response?.type === 'update')
    rest.tool_response_type = response.type;
  // The voice narration only needs to know how a command ended ("3 failed").
  if (rest.tool_name === 'Bash' && response && typeof response === 'object') {
    const output = `${response.stdout ?? ''}\n${response.stderr ?? ''}`.trim();
    if (output) rest.tool_output_tail = output.slice(-300);
  }
  if (rest.tool_input) rest.tool_input = truncateLargeStrings(rest.tool_input);
  return rest;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  // Claude Code always sends an object; anything else would throw on the
  // property writes below and break the exit-0 promise.
  if (!event || typeof event !== 'object' || Array.isArray(event)) process.exit(0);
  if (TOOL_EVENTS.includes(event?.hook_event_name)) event = slimToolEvent(event);
  const { WAVETERM_BLOCKID, WAVETERM_TABID, WAVETERM_JWT } = process.env;
  if (WAVETERM_BLOCKID && WAVETERM_TABID && WAVETERM_JWT) {
    event.wave = { blockId: WAVETERM_BLOCKID, tabId: WAVETERM_TABID, jwt: WAVETERM_JWT };
  }
  // Each terminal stamps its tabs/panes with identifying env vars, and this
  // hook inherits the session's environment — the only place that identity is
  // visible. Raw values only; interpreting them is the app's job.
  const term = {};
  for (const key of [
    'ITERM_SESSION_ID',
    'TERM_SESSION_ID',
    'KITTY_WINDOW_ID',
    'KITTY_LISTEN_ON',
    'WEZTERM_PANE',
    'WEZTERM_UNIX_SOCKET',
    'GNOME_TERMINAL_SCREEN',
    'GNOME_TERMINAL_SERVICE',
    'TMUX',
    'TMUX_PANE',
    'WT_SESSION',
    // Warp hands every session a uuid that its own warp://session/<uuid> url
    // focuses — the whole tab hunt collapses into opening that link.
    'WARP_TERMINAL_SESSION_UUID',
    // Set on every terminal the Vizor workspace spawns: ties the session to
    // its embedded tab.
    'VIZOR_PTY_ID',
  ]) {
    if (process.env[key]) term[key] = process.env[key];
  }
  if (Object.keys(term).length) event.term = term;
  const socket = net.connect(socketPath);
  socket.on('connect', () => socket.end(`${JSON.stringify(event)}\n`));
  socket.on('close', () => process.exit(0));
  socket.on('error', () => {
    fallbackNotify(event);
    process.exit(0);
  });
});
