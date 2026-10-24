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

// VIZOR_INTERNAL would silence every hook of the sessions started there, and
// ELECTRON_RUN_AS_NODE would break any Electron app launched from the shell.
const NEVER_INHERITED = ['VIZOR_INTERNAL', 'CLAUDE_MANAGER_INTERNAL', 'ELECTRON_RUN_AS_NODE'];

export function ptyEnv(baseEnv, id) {
  const env = { ...baseEnv };
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
    const info = { id, cwd, alive: true, exitCode: null, startedAt: Date.now() };
    const entry = { info, child, buffer: '', pending: '', timer: null };
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
      if (entry.buffer.length > PTY_BUFFER_CHARS) entry.buffer = entry.buffer.slice(-PTY_BUFFER_CHARS);
      entry.pending += data;
      if (!entry.timer) entry.timer = setTimer(() => flush(entry), PTY_BATCH_MS);
      typeClaude();
    });
    child.onExit(({ exitCode }) => {
      flush(entry);
      if (fallback) clearTimer(fallback);
      entry.info.alive = false;
      entry.info.exitCode = exitCode ?? null;
      host.emit('exit', { id, exitCode: entry.info.exitCode });
      host.emit('change');
    });
    host.emit('change');
    return { ...info };
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

  host.list = () => [...terminals.values()].map((entry) => ({ ...entry.info }));
  host.buffer = (id) => terminals.get(id)?.buffer ?? '';
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
