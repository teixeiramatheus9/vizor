import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// The workspace's terminals. They live in main, not in the window: closing the
// window must not kill a running claude, and reopening replays the scrollback.
// Pure apart from the injected spawn (node-pty's signature), so it is tested
// with a fake.

export const PTY_BUFFER_CHARS = 1048576;
// A flood (`yes`, a big cat) would otherwise mean one IPC message per chunk;
// batching keeps the main process and the window responsive.
export const PTY_BATCH_MS = 16;
const CLAUDE_FALLBACK_MS = 1500;
// Flow control (#113): output sent to the window but not yet drawn by xterm.
// Past HIGH the pty is paused (the program blocks on write, like in any real
// terminal), and resumed once the window catches up below LOW.
export const PTY_FLOW_HIGH = 1048576;
export const PTY_FLOW_LOW = 262144;
const ENDED_BUFFER_CHARS = 65536;

// A cut buffer can start mid escape sequence or mid surrogate pair, and the
// replay would open with garbage: restart it at the next line (#112).
function trimToLine(text) {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(newline + 1);
}

// VIZOR_INTERNAL would silence every hook of the sessions started there, and
// ELECTRON_RUN_AS_NODE would break any Electron app launched from the shell.
// The rest is the identity of the terminal the Vizor itself was launched from
// (npm start in kitty, tmux…): the hook would pin the embedded sessions on
// THAT terminal — focus and the typed quick-reply fallback would go there —
// and tmux would refuse to start, thinking it is nested.
const NEVER_INHERITED = [
  'VIZOR_INTERNAL',
  'CLAUDE_MANAGER_INTERNAL',
  'ELECTRON_RUN_AS_NODE',
  'TMUX',
  'TMUX_PANE',
  'KITTY_WINDOW_ID',
  'KITTY_LISTEN_ON',
  'WEZTERM_PANE',
  'WEZTERM_UNIX_SOCKET',
  'WARP_TERMINAL_SESSION_UUID',
  'GNOME_TERMINAL_SCREEN',
  'GNOME_TERMINAL_SERVICE',
  'ITERM_SESSION_ID',
  'TERM_SESSION_ID',
  'WT_SESSION',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VTE_VERSION',
  'WINDOWID',
];

// The identity of the Claude Code session the Vizor was launched from (npm
// start inside a chat): a claude in a tab would think it is that session's
// child — no transcript, the parent's messaging socket (#151). The user's own
// CLAUDE_CODE_* settings (Bedrock, Vertex…) are not identity and stay.
const CLAUDE_SESSION_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];
const CLAUDE_SESSION_PREFIXES = ['CLAUDE_CODE_SESSION_', 'CLAUDE_CODE_MESSAGING_'];

export function withoutClaudeSession(env) {
  for (const key of Object.keys(env)) {
    if (CLAUDE_SESSION_KEYS.includes(key) || CLAUDE_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix)))
      delete env[key];
  }
  return env;
}

export function ptyEnv(baseEnv, id) {
  const env = withoutClaudeSession({ ...baseEnv });
  for (const key of NEVER_INHERITED) delete env[key];
  return { ...env, VIZOR_PTY_ID: id, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export function createPtyHost({
  spawn,
  shell,
  newId = randomUUID,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const host = new EventEmitter();
  const terminals = new Map(); // id → { info, child, buffer, pending, timer }

  function flush(entry) {
    if (entry.timer) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
    if (!entry.pending) return;
    const data = entry.pending;
    entry.pending = '';
    entry.unacked += data.length;
    if (!entry.paused && entry.unacked > PTY_FLOW_HIGH && entry.info.alive) {
      entry.paused = true;
      entry.child.pause?.();
    }
    host.emit('data', { id: entry.info.id, data });
  }

  host.open = ({ cwd, cols = 80, rows = 24, startClaude = false }) => {
    const id = newId();
    const child = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: ptyEnv(process.env, id),
    });
    const info = { id, cwd, alive: true, exitCode: null, startedAt: Date.now(), title: null };
    const entry = { info, child, buffer: '', pending: '', timer: null, unacked: 0, paused: false };
    terminals.set(id, entry);

    // Typed once the shell first speaks (its prompt is up), or after a silent
    // second and a half — a shell's line editor queues typeahead either way.
    let claudeTyped = !startClaude;
    const typeClaude = () => {
      if (claudeTyped || !entry.info.alive) return;
      claudeTyped = true;
      clearTimer(fallback);
      child.write('claude\r');
    };
    const fallback = startClaude ? setTimer(typeClaude, CLAUDE_FALLBACK_MS) : null;

    child.onData((data) => {
      entry.buffer += data;
      if (entry.buffer.length > PTY_BUFFER_CHARS) entry.buffer = trimToLine(entry.buffer.slice(-PTY_BUFFER_CHARS));
      entry.pending += data;
      if (!entry.timer) entry.timer = setTimer(() => flush(entry), PTY_BATCH_MS);
      typeClaude();
    });
    child.onExit(({ exitCode }) => {
      flush(entry);
      if (fallback) clearTimer(fallback);
      entry.info.alive = false;
      entry.info.exitCode = exitCode ?? null;
      // An ended tab is read, not scrolled for megabytes: keep its tail (#116).
      if (entry.buffer.length > ENDED_BUFFER_CHARS)
        entry.buffer = trimToLine(entry.buffer.slice(-ENDED_BUFFER_CHARS));
      host.emit('exit', { id, exitCode: entry.info.exitCode });
      host.emit('change');
    });
    host.emit('change');
    return { ...info };
  };

  // The window drew `chars` more characters of this terminal's output.
  host.ack = (id, chars) => {
    const entry = terminals.get(id);
    if (!entry || !Number.isFinite(chars) || chars <= 0) return;
    entry.unacked = Math.max(0, entry.unacked - chars);
    if (entry.paused && entry.unacked < PTY_FLOW_LOW) {
      entry.paused = false;
      if (entry.info.alive) entry.child.resume?.();
    }
  };

  // The window (re)loaded: whatever was in flight will never be acked.
  host.resetFlow = () => {
    for (const id of terminals.keys()) host.ack(id, Number.MAX_SAFE_INTEGER);
  };

  host.write = (id, data) => {
    const entry = terminals.get(id);
    if (entry?.info.alive) entry.child.write(data);
  };

  host.resize = (id, cols, rows) => {
    const entry = terminals.get(id);
    if (entry?.info.alive) entry.child.resize(cols, rows);
  };

  host.close = (id) => {
    const entry = terminals.get(id);
    if (!entry) return;
    if (entry.timer) clearTimer(entry.timer);
    if (entry.info.alive) entry.child.kill();
    terminals.delete(id);
    host.emit('change');
  };

  // Titles come from the terminal itself (claude sets the chat's); kept here so
  // a reloaded window gets them back (#117).
  host.setTitle = (id, title) => {
    const entry = terminals.get(id);
    if (entry && typeof title === 'string') entry.info.title = title.slice(0, 200);
  };

  host.list = () => [...terminals.values()].map((entry) => ({ ...entry.info }));
  // Pending output is flushed first: its live event then reaches the window
  // before the replay does (and is dropped by a view that is not ready yet),
  // so a chunk can never land in both.
  host.buffer = (id) => {
    const entry = terminals.get(id);
    if (!entry) return '';
    flush(entry);
    return entry.buffer;
  };
  // The terminal device of a live pty (/dev/pts/N): with the session's pid,
  // it tells whether that claude is the job in front (pty-foreground.js).
  host.ttyPath = (id) => {
    const entry = terminals.get(id);
    return entry?.info.alive ? (entry.child._pty ?? null) : null;
  };
  host.aliveCount = () => [...terminals.values()].filter((entry) => entry.info.alive).length;

  host.killAll = () => {
    for (const entry of terminals.values()) {
      if (!entry.info.alive) continue;
      entry.child.kill();
      entry.info.alive = false;
    }
  };

  return host;
}
