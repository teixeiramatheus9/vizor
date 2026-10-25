import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir, longProjectPrefix } from './cc-sessions.js';
import { isSessionId } from './workspace-tabs.js';
import { readConversationTitle } from './transcript.js';

const HEAD_BYTES = 64 * 1024;

async function readHead(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// The cwd a transcript's chat ran in: the first entry near its start that says.
function cwdOf(head) {
  for (const raw of head.split('\n')) {
    try {
      const cwd = JSON.parse(raw)?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch {
      // partial or broken line
    }
  }
  return null;
}

// Where Claude Code keeps a folder's chats. A short path is just its flattened
// name. A long one is cut and hashed (#157), and the hash changed between
// Claude Code builds: when the computed name is missing, the folder with the
// same cut prefix whose chats ran in this very cwd is the one.
export async function resolveClaudeProjectDir(
  cwd,
  { home = os.homedir(), readdir = fs.readdir, readHead: head = readHead } = {},
) {
  const exact = claudeProjectDir(cwd, { home });
  const prefix = longProjectPrefix(cwd);
  if (!prefix) return exact;
  const projects = path.dirname(exact);
  let names;
  try {
    names = await readdir(projects);
  } catch {
    return exact;
  }
  if (names.includes(path.basename(exact))) return exact;
  for (const name of names.filter((candidate) => candidate.startsWith(prefix))) {
    const dir = path.join(projects, name);
    let files;
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl')).slice(0, 3);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        if (cwdOf(await head(path.join(dir, file))) === cwd) return dir;
      } catch {
        // unreadable: try the next one
      }
    }
  }
  return exact;
}

// The chats Claude Code saved for a folder (~/.claude/projects/<flattened>),
// newest first, for "retomar conversa" (#154). Only <session id>.jsonl files
// with something in them: an empty one is a chat that never got a message.
export async function listConversations(
  dir,
  { readdir = fs.readdir, stat = fs.stat, readTitle = readConversationTitle, limit = 15 } = {},
) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !isSessionId(name.slice(0, -'.jsonl'.length))) continue;
    try {
      const info = await stat(path.join(dir, name));
      if (info.size > 0) candidates.push({ name, updatedAt: info.mtimeMs });
    } catch {
      // gone between readdir and stat
    }
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(
    candidates.slice(0, limit).map(async ({ name, updatedAt }) => ({
      sessionId: name.slice(0, -'.jsonl'.length),
      title: await readTitle(path.join(dir, name)),
      updatedAt,
    })),
  );
}
