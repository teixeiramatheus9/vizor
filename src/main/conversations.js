import fs from 'node:fs/promises';
import path from 'node:path';
import { isSessionId } from './workspace-tabs.js';
import { readConversationTitle } from './transcript.js';

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
