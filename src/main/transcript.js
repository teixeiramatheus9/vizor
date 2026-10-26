import { open, stat } from 'node:fs/promises';

const TAIL_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 1500;

export function parseLastAssistantMessage(jsonlText) {
  const lines = jsonlText.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) continue;
    return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
  }
  return null;
}

// Claude Code titles the chat itself ("ai-title" entries) and pushes that same
// string to the terminal — so it is THE text a tab running the session shows.
export function parseAiTitle(jsonlText) {
  const lines = jsonlText.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'ai-title' || typeof entry.aiTitle !== 'string') continue;
    const title = entry.aiTitle.trim();
    if (title) return title;
  }
  return null;
}

// The name a chat goes by in a list: the one the user gave it (/rename),
// else Claude's own title, else what was last asked. Latest of each wins.
export function parseConversationTitle(jsonlText) {
  const found = {};
  for (const raw of jsonlText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    if (entry?.type === 'custom-title') found.custom = text(entry.customTitle) ?? found.custom;
    else if (entry?.type === 'ai-title') found.ai = text(entry.aiTitle) ?? found.ai;
    else if (entry?.type === 'summary') found.summary = text(entry.summary) ?? found.summary;
    else if (entry?.type === 'last-prompt') found.prompt = text(entry.lastPrompt) ?? found.prompt;
  }
  return found.custom ?? found.ai ?? found.summary ?? found.prompt ?? null;
}

export async function readConversationTitle(transcriptPath) {
  try {
    const tail = await readTail(transcriptPath);
    const custom = await customTitles.lookup(transcriptPath).catch(() => null);
    return custom ?? parseConversationTitle(tail);
  } catch {
    return null;
  }
}

// A /rename can sit anywhere in a chat, the tail alone misses an early one
// (#157). The file is scanned in chunks and only short lines that mention
// custom-title are parsed, so memory stays bounded however long the chat or
// its lines. Transcripts only grow: the next scan starts where the last
// complete line ended, unless the file was replaced (another inode) or shrank.
// The menu never waits on a big scan: past fullScanLimit it gets what is known
// so far (the caller falls back to the tail) and the scan runs in the
// background for the next open. At most `concurrency` files are read at once,
// and one scan per file is ever in flight.
export function createCustomTitleScanner({
  open: openFile = open,
  stat: statFile = stat,
  chunkBytes = 1024 * 1024,
  fullScanLimit = 20 * 1024 * 1024,
  concurrency = 2,
  maxEntries = 200,
} = {}) {
  const scanned = new Map(); // path → { ino, offset, custom }
  const inflight = new Map(); // path → promise of the custom title
  const waiting = [];
  let running = 0;

  const acquire = () =>
    running < concurrency ? ((running += 1), Promise.resolve()) : new Promise((resolve) => waiting.push(resolve));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  const resumable = (prior, info) => Boolean(prior) && prior.ino === info.ino && info.size >= prior.offset;

  async function scan(file) {
    await acquire();
    try {
      const info = await statFile(file);
      const prior = scanned.get(file);
      const from = resumable(prior, info) ? prior : { ino: info.ino, offset: 0, custom: null };
      const result = await scanCustomTitles(openFile, file, from, info.size, chunkBytes);
      scanned.delete(file);
      scanned.set(file, result);
      if (scanned.size > maxEntries) scanned.delete(scanned.keys().next().value);
      return result.custom;
    } finally {
      release();
    }
  }

  function scanOnce(file) {
    let promise = inflight.get(file);
    if (!promise) {
      promise = scan(file).finally(() => inflight.delete(file));
      inflight.set(file, promise);
    }
    return promise;
  }

  return {
    async lookup(file) {
      const info = await statFile(file);
      const prior = scanned.get(file);
      const known = resumable(prior, info) ? prior : null;
      if (known && known.offset === info.size) return known.custom;
      const pending = scanOnce(file);
      if (info.size - (known?.offset ?? 0) <= fullScanLimit) return pending;
      pending.catch(() => {}); // background: the next open reads the result
      return known?.custom ?? null;
    },
    idle: () => Promise.allSettled([...inflight.values()]).then(() => undefined),
  };
}

const MAX_TITLE_LINE_BYTES = 16 * 1024;
const customTitles = createCustomTitleScanner();

// Scans [from.offset, size) and returns a new state; `from` is never mutated.
async function scanCustomTitles(openFile, file, from, size, chunkBytes) {
  const scan = { ...from };
  if (size <= scan.offset) return scan;
  const handle = await openFile(file, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(chunkBytes, size - scan.offset));
    let position = scan.offset;
    let pending = [];
    let pendingBytes = 0;
    let overflow = false;
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (!bytesRead) break;
      let from = 0;
      for (let newline = chunk.indexOf(10, from); newline !== -1 && newline < bytesRead; newline = chunk.indexOf(10, from)) {
        if (!overflow && pendingBytes + newline - from <= MAX_TITLE_LINE_BYTES) {
          const text = Buffer.concat([...pending, chunk.subarray(from, newline)]).toString('utf8');
          scan.custom = customTitleOf(text) ?? scan.custom;
        }
        pending = [];
        pendingBytes = 0;
        overflow = false;
        from = newline + 1;
        scan.offset = position + from;
      }
      const rest = bytesRead - from;
      if (!overflow && pendingBytes + rest <= MAX_TITLE_LINE_BYTES) {
        pending.push(Buffer.from(chunk.subarray(from, bytesRead)));
        pendingBytes += rest;
      } else {
        pending = [];
        pendingBytes = 0;
        overflow = true;
      }
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return scan;
}

function customTitleOf(line) {
  if (!line.includes('custom-title')) return null;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== 'custom-title' || typeof entry.customTitle !== 'string') return null;
    return entry.customTitle.trim() || null;
  } catch {
    return null;
  }
}

function isAssistantEntry(entry) {
  return entry?.type === 'assistant' || entry?.message?.role === 'assistant';
}

function isUserEntry(entry) {
  return entry?.type === 'user' || entry?.message?.role === 'user';
}

// A question is "pending" when an AskUserQuestion tool call appears after the
// last user entry — i.e. Claude asked and nobody answered yet.
export function parsePendingQuestion(jsonlText) {
  const lines = jsonlText.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isUserEntry(entry)) return null;
    if (!isAssistantEntry(entry)) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const ask = content.find(
      (block) => block?.type === 'tool_use' && block.name === 'AskUserQuestion',
    );
    if (!ask?.input?.questions?.length) continue;
    return {
      questions: ask.input.questions.map((item) => ({
        question: String(item.question ?? ''),
        multiSelect: item.multiSelect === true,
        options: (item.options ?? []).map((option) => String(option.label ?? '')).filter(Boolean),
      })),
    };
  }
  return null;
}

// The conversation as the user had it: their prompts and the assistant's
// prose, nothing else. Tool traffic, sidechains (subagents write into the same
// file), injected meta prompts and compact summaries are all skipped — the
// mirror in the panel shows what the terminal showed.
export function parseConversationTail(jsonlText, { limit = 30, maxChars = 600 } = {}) {
  const messages = [];
  for (const rawLine of jsonlText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain === true || entry?.isMeta === true || entry?.isCompactSummary === true) {
      continue;
    }
    const role = entry?.type === 'user' ? 'user' : entry?.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = entry.message?.content;
    const text = (
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
          : ''
    ).trim();
    if (!text) continue;
    messages.push({
      role,
      text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    });
  }
  return messages.slice(-limit);
}

export async function readConversationTail(transcriptPath, options) {
  try {
    return parseConversationTail(await readTail(transcriptPath), options);
  } catch {
    return [];
  }
}

async function readTail(transcriptPath) {
  const { size } = await stat(transcriptPath);
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await handle.close();
  }
}

export async function readTranscriptSnapshot(transcriptPath) {
  try {
    const text = await readTail(transcriptPath);
    return {
      lastAssistantMessage: parseLastAssistantMessage(text),
      pendingQuestion: parsePendingQuestion(text),
    };
  } catch {
    return { lastAssistantMessage: null, pendingQuestion: null };
  }
}

export async function readAiTitle(transcriptPath) {
  try {
    return parseAiTitle(await readTail(transcriptPath));
  } catch {
    return null;
  }
}

export async function readLastAssistantMessage(transcriptPath) {
  const snapshot = await readTranscriptSnapshot(transcriptPath);
  return snapshot.lastAssistantMessage;
}

// A real prompt from the user, as opposed to the tool_result lines Claude Code
// also files under type 'user'.
function isUserPrompt(entry) {
  if (!isUserEntry(entry)) return false;
  // Claude Code files its own notes (caveats, command output) as meta user
  // entries: not something the user said, so never a turn boundary (#133).
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((block) => block?.type !== 'tool_result');
}

function textBlocks(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
}

// The "why" of an edit: what the AI said right before calling the tool. Each
// content block of a reply is its own line, tied by message.id, so the text
// of the same reply comes first; failing that, the last thing it said since
// the user's prompt. Never older than that prompt, never a subagent's words.
export function parseEditReason(jsonlText, toolUseId, { maxChars = 200 } = {}) {
  const entries = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a partial last line while the transcript is being written
    }
  }
  const index = entries.findIndex(
    (entry) =>
      isAssistantEntry(entry) &&
      Array.isArray(entry.message?.content) &&
      entry.message.content.some((block) => block?.type === 'tool_use' && block.id === toolUseId),
  );
  if (index === -1) return null;

  const own = entries[index];
  const ownContent = own.message.content;
  const toolAt = ownContent.findIndex((block) => block?.type === 'tool_use' && block.id === toolUseId);
  let collected = textBlocks(ownContent.slice(0, toolAt));
  let fallback = null;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const entry = entries[cursor];
    if (entry?.isSidechain) continue;
    if (isUserPrompt(entry)) break;
    if (!isAssistantEntry(entry)) continue;
    const texts = textBlocks(entry.message?.content);
    if (entry.message?.id === own.message.id) {
      collected = [...texts, ...collected];
      continue;
    }
    if (texts.length) {
      fallback = texts;
      break;
    }
  }
  const text = (collected.length ? collected : (fallback ?? [])).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export async function readEditReason(transcriptPath, toolUseId) {
  try {
    return parseEditReason(await readTail(transcriptPath), toolUseId);
  } catch {
    return null;
  }
}

// The command behind a change no Edit/Write made (#94): the last Bash call of
// the session since the user's prompt — never an older turn's, never a
// subagent's. A guess, so the inspector shows it as "$ <command>".
export function parseLastBashCommand(jsonlText, { maxChars = 200 } = {}) {
  const lines = jsonlText.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain) continue;
    if (isUserPrompt(entry)) return null;
    if (!isAssistantEntry(entry) || !Array.isArray(entry.message?.content)) continue;
    const call = entry.message.content.findLast(
      (block) => block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string',
    );
    if (!call) continue;
    const command = call.input.command.replace(/\s+/g, ' ').trim();
    return command.length > maxChars ? `${command.slice(0, maxChars)}…` : command;
  }
  return null;
}

export async function readLastBashCommand(transcriptPath) {
  try {
    return parseLastBashCommand(await readTail(transcriptPath));
  } catch {
    return null;
  }
}

// Esc in Claude Code fires no Stop hook — the turn just ends with this marker
// in the transcript. Seen last, the session is idle: whatever changes on disk
// now is the user's, not the AI's (#94 review).
export function parseInterrupted(jsonlText) {
  const lines = jsonlText.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain) continue;
    if (isUserEntry(entry)) {
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : textBlocks(content).join(' ');
      if (text.includes('[Request interrupted by user')) return true;
      if (isUserPrompt(entry)) return false;
      continue;
    }
    if (isAssistantEntry(entry)) return false;
  }
  return false;
}

export async function readInterrupted(transcriptPath) {
  try {
    return parseInterrupted(await readTail(transcriptPath));
  } catch {
    return false;
  }
}
