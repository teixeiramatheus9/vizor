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

function readOriginal() {
  try {
    const { command } = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
    return typeof command === 'string' && command.trim() ? command : null;
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

function runOriginal(command, raw) {
  return new Promise((resolve) => {
    const [shell, args] =
      process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', command]] : ['sh', ['-c', command]];
    const child = spawn(shell, args, { stdio: ['pipe', 'inherit', 'inherit'] });
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
  const raw = await readStdin();
  try {
    const internal = process.env.VIZOR_INTERNAL === '1' || process.env.CLAUDE_MANAGER_INTERNAL === '1';
    const message = internal ? null : buildMessage(raw);
    if (message) await send(message);
  } catch {
    // the dev's status line matters more than the forward
  }
  const original = readOriginal();
  return original ? runOriginal(original, raw) : 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
