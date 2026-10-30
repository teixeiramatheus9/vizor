import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code registers every live session here: one <pid>.json carrying the
// messaging socket path, plus a sibling <pid>.<hash>.key holding that session's
// auth token. The sessionId in the json is the same id the hooks report, which
// is what lets the manager address a session without touching its window.
export const claudeSessionsDir = path.join(os.homedir(), '.claude', 'sessions');

export function parseSessionRecord(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const pid = raw?.pid;
  const sessionId = raw?.sessionId;
  const socketPath = raw?.messagingSocketPath;
  if (!Number.isInteger(pid) || typeof sessionId !== 'string' || !sessionId) return null;
  if (typeof socketPath !== 'string' || !socketPath) return null;
  return {
    pid,
    sessionId,
    socketPath,
    procStart: typeof raw.procStart === 'string' ? raw.procStart : null,
    peerProtocol: typeof raw.peerProtocol === 'number' ? raw.peerProtocol : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    status: typeof raw.status === 'string' ? raw.status : null,
  };
}

// Protocol 1 is the only wire format this app knows how to speak. Anything else
// means Claude Code changed it, and writing to the socket anyway would be worse
// than falling back to the terminal.
export function isSupported(record) {
  return Boolean(record) && record.peerProtocol === 1 && Boolean(record.socketPath);
}

// Field 22 of /proc/<pid>/stat is the process start time in clock ticks, which
// Claude Code copies into procStart. Comparing them rejects a recycled pid.
// The comm field (field 2) is parenthesised and can contain spaces, so counting
// starts after the last closing paren, where the next token is field 3 — which
// puts field 22 at index 19.
export function procStartFromStat(statText) {
  const text = String(statText ?? '');
  const tail = text
    .slice(text.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  return tail[19] ?? null;
}

export function parsePeerKey(text) {
  try {
    const token = JSON.parse(text)?.peerToken;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

function defaultProcStartFor(pid) {
  try {
    return procStartFromStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function defaultIsAlive(pid) {
  try {
    // signal 0 only runs the permission/existence check, it delivers nothing.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid is taken by a process this user cannot signal, which
    // still counts as alive; only ESRCH proves nobody is there.
    return error?.code === 'EPERM';
  }
}

// Liveness only: which sessions still have a running process behind them. This
// deliberately ignores peerProtocol and the socket path — a session the
// messaging channel cannot use is still alive, and reaping it would be wrong.
// Returns null when there is no registry to read, which means "no opinion":
// callers must not treat that as "every session is dead".
export function readLiveSessionIds({
  dir = claudeSessionsDir,
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
  procStartFor = defaultProcStartFor,
  isAlive = defaultIsAlive,
} = {}) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const alive = new Set();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const { pid, sessionId } = raw ?? {};
    if (!Number.isInteger(pid) || typeof sessionId !== 'string' || !sessionId) continue;
    if (!isAlive(pid)) continue;
    // A <pid>.json can outlive its process, so the pid may already belong to
    // something else. procStart is absent on platforms without /proc — and a
    // local probe that returns null means "cannot verify", not "dead".
    const procStart = typeof raw.procStart === 'string' ? raw.procStart : null;
    if (procStart) {
      const localStart = procStartFor(pid);
      if (localStart && localStart !== procStart) continue;
    }
    alive.add(sessionId);
  }
  return alive;
}

// Sessions the panel can adopt: live interactive CLI chats the hooks never
// reported, either opened before the manager or closed from the panel.
// Sub-agents and headless runs are not chats the user manages, so they stay
// out. Returns null when there is no registry to read — "no opinion", same as
// readLiveSessionIds.
export function readAdoptableSessions({
  dir = claudeSessionsDir,
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
  procStartFor = defaultProcStartFor,
  isAlive = defaultIsAlive,
} = {}) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const { pid, sessionId, cwd, kind, entrypoint } = raw ?? {};
    if (!Number.isInteger(pid) || typeof sessionId !== 'string' || !sessionId) continue;
    if (typeof cwd !== 'string' || !cwd) continue;
    if (kind !== 'interactive' || entrypoint !== 'cli') continue;
    if (!isAlive(pid)) continue;
    const procStart = typeof raw.procStart === 'string' ? raw.procStart : null;
    if (procStart && procStartFor(pid) !== procStart) continue;
    sessions.push({
      sessionId,
      cwd,
      name: typeof raw.name === 'string' ? raw.name : null,
      status: typeof raw.status === 'string' ? raw.status : null,
    });
  }
  return sessions;
}

// Claude Code keeps transcripts under ~/.claude/projects/<flattened cwd>,
// where every character that is not a plain letter or digit collapses to a
// dash — slashes, dots, spaces, accents (C:\Users\u\dev\proj ->
// C--Users-u-dev-proj, Adaptação -> Adapta--o). A name longer than 200 chars
// is cut there and gets "-<hash of the raw path, base 36>" (Claude Code 2.1;
// older builds hashed differently, see resolveClaudeProjectDir).
const MAX_PROJECT_NAME = 200;

function pathHash(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

export function flattenProjectName(cwd) {
  const flat = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  if (flat.length <= MAX_PROJECT_NAME) return flat;
  return `${flat.slice(0, MAX_PROJECT_NAME)}-${pathHash(String(cwd))}`;
}

// What a long name starts with whatever the hash: "" when the name is short.
export function longProjectPrefix(cwd) {
  const flat = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return flat.length > MAX_PROJECT_NAME ? `${flat.slice(0, MAX_PROJECT_NAME)}-` : '';
}

export function claudeProjectDir(cwd, { home = os.homedir() } = {}) {
  return path.join(home, '.claude', 'projects', flattenProjectName(cwd));
}

export function claudeTranscriptPath(cwd, sessionId, { home = os.homedir() } = {}) {
  return path.join(claudeProjectDir(cwd, { home }), `${sessionId}.jsonl`);
}

// Resolves a hook-reported sessionId to the live pid of its claude process,
// or null. Unlike readSessionChannel this ignores the messaging protocol gate:
// the pid is for locating the session's terminal (its tty), not for talking.
export function readSessionPid(
  sessionId,
  {
    dir = claudeSessionsDir,
    readdirSync = fs.readdirSync,
    readFileSync = fs.readFileSync,
    procStartFor = defaultProcStartFor,
    isAlive = defaultIsAlive,
  } = {},
) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    const { pid } = raw ?? {};
    if (raw?.sessionId !== sessionId || !Number.isInteger(pid)) continue;
    if (!isAlive(pid)) continue;
    const procStart = typeof raw.procStart === 'string' ? raw.procStart : null;
    if (procStart) {
      const localStart = procStartFor(pid);
      if (localStart && localStart !== procStart) continue;
    }
    return pid;
  }
  return null;
}

// Resolves a hook-reported sessionId to everything needed to talk to that
// session's socket, or null when there is no usable channel — in which case the
// caller falls back to driving the terminal window.
export function readSessionChannel(
  sessionId,
  {
    dir = claudeSessionsDir,
    readdirSync = fs.readdirSync,
    readFileSync = fs.readFileSync,
    procStartFor = defaultProcStartFor,
  } = {},
) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // no registry at all — this Claude Code build predates it
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let record;
    try {
      record = parseSessionRecord(readFileSync(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    if (!record || record.sessionId !== sessionId || !isSupported(record)) continue;
    if (record.procStart) {
      const localStart = procStartFor(record.pid);
      if (localStart && localStart !== record.procStart) continue;
    }

    const keyEntry = entries.find(
      (name) => name.startsWith(`${record.pid}.`) && name.endsWith('.key'),
    );
    let token = null;
    if (keyEntry) {
      try {
        token = parsePeerKey(readFileSync(path.join(dir, keyEntry), 'utf8'));
      } catch {
        token = null; // unreadable key: auth is optional on some builds, so try anyway
      }
    }
    return {
      socketPath: record.socketPath,
      token,
      pid: record.pid,
      name: record.name,
      status: record.status,
    };
  }
  return null;
}
