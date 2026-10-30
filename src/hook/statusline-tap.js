#!/usr/bin/env node
// Standalone on purpose (like hook-emit.js): Claude Code runs this as its
// statusLine command on every refresh. It forwards the usage numbers to the
// Vizor socket, then runs the dev's original status line unchanged. The
// original lives in ~/.config/vizor/statusline-original.json.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SEND_BUDGET_MS = 150;

// Must mirror hook-emit.js / src/main/paths.js (no imports allowed here).
const socketPath =
  process.env.VIZOR_SOCKET ??
  (process.platform === 'win32'
    ? `\\\\.\\pipe\\vizor-${os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '-')}`
    : path.join(os.homedir(), '.config', 'vizor', 'vizor.sock'));
const originalFile = path.join(os.homedir(), '.config', 'vizor', 'statusline-original.json');

// Mirrors isStatusLineTap in scripts/install-hooks.js (standalone file): a
// sidecar pointing back at the tap would loop.
const TAP_COMMAND = /(^|[\\/"'\s])statusline-tap\.(js|cmd)(["'\s]|$)/;

function readOriginal() {
  try {
    const { command } = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
    if (typeof command !== 'string' || !command.trim() || TAP_COMMAND.test(command)) return null;
    return command;
  } catch {
    return null;
  }
}

function buildMessage(raw) {
  try {
    const input = JSON.parse(raw.toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    return {
      type: 'StatusLine',
      session_id: input.session_id,
      cwd: input.cwd ?? input.workspace?.current_dir,
      cost_usd: input.cost?.total_cost_usd,
      rate_limits: input.rate_limits,
    };
  } catch {
    return null;
  }
}

// Resolves once the line is flushed, the socket fails, or the budget runs out.
function send(message) {
  return new Promise((resolve) => {
    let socket;
    const done = () => {
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // nothing to clean up
      }
      resolve();
    };
    const timer = setTimeout(done, SEND_BUDGET_MS);
    try {
      socket = net.connect(socketPath);
      socket.on('error', done);
      socket.on('connect', () => socket.end(`${JSON.stringify(message)}\n`, done));
    } catch {
      done();
    }
  });
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function runOriginal(command, raw) {
  return new Promise((resolve) => {
    const [shell, args] =
      process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', command]] : ['sh', ['-c', command]];
    // The original must not see the tap's own runtime switches, and a tap
    // that starts with VIZOR_TAP_ACTIVE set knows it is inside itself.
    const env = { ...process.env, VIZOR_TAP_ACTIVE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const posix = process.platform !== 'win32';
    // Own process group on posix, so a signal reaches the whole pipeline.
    const child = spawn(shell, args, { stdio: ['pipe', 'inherit', 'inherit'], env, detached: posix });
    for (const [name, number] of Object.entries(SIGNALS)) {
      process.on(name, () => {
        try {
          if (posix && child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch {
          // already gone
        }
        process.exit(128 + number);
      });
    }
    child.stdin.on('error', () => {});
    child.on('error', () => resolve(0));
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.end(raw);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  if (process.env.VIZOR_TAP_ACTIVE === '1') return 0;
  const raw = await readStdin();
  // The message is initiated first but never holds the original back.
  let sent = Promise.resolve();
  try {
    const internal = process.env.VIZOR_INTERNAL === '1' || process.env.CLAUDE_MANAGER_INTERNAL === '1';
    const message = internal ? null : buildMessage(raw);
    if (message) sent = send(message).catch(() => {});
  } catch {
    // the dev's status line matters more than the forward
  }
  const original = readOriginal();
  const code = original ? await runOriginal(original, raw) : 0;
  await sent;
  return code;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
