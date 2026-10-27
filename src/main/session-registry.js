import { EventEmitter } from 'node:events';
import path from 'node:path';

export const STATUS = {
  WORKING: 'working',
  DONE: 'done',
  WAITING: 'waiting',
  FAILED: 'failed',
};

const HANDLED_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification'];
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DIED_MID_TURN = 'a sessão fechou no meio do turno';

// Claude Code identifies its sessions by uuid, so anything else — the
// simulate-event.sh fixtures, above all — can never appear in its registry and
// must not be judged by whether it does.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isClaudeSessionId(sessionId) {
  return SESSION_ID_RE.test(String(sessionId ?? ''));
}

export class SessionRegistry extends EventEmitter {
  constructor({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = () => Date.now(), folderAliasFor } = {}) {
    super();
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    // Folder defaults baptize NEWBORN sessions only (the name becomes the
    // session's own alias, renameable after). Applying them at display time
    // instead renamed every chat in the folder at once — the very confusion
    // aliases exist to solve.
    this.folderAliasFor = folderAliasFor ?? (() => null);
    this.sessions = new Map();
  }

  applyEvent(event) {
    const eventName = event?.hook_event_name;
    const sessionId = event?.session_id;
    if (!sessionId || !HANDLED_EVENTS.includes(eventName)) return null;

    const isNew = !this.sessions.has(sessionId);
    const session = this.sessions.get(sessionId) ?? {
      id: sessionId,
      cwd: '',
      projectName: 'sessão',
      transcriptPath: null,
      status: STATUS.WORKING,
      title: null,
      promptPreview: null,
      question: null,
      managerMessage: null,
      lastMessage: null,
      unread: false,
      updatedAt: 0,
      wave: null,
      term: null,
      seenAlive: false,
      alias: null,
      needsPermission: false,
    };
    if (event.wave?.blockId) session.wave = event.wave;
    if (event.term && typeof event.term === 'object' && Object.keys(event.term).length) {
      session.term = event.term;
    }
    // Main found the session's VIZOR_PTY_ID doesn't hold (#140): drop only that.
    if (event.dropPtyId && session.term?.VIZOR_PTY_ID) {
      const { VIZOR_PTY_ID: _dropped, ...rest } = session.term;
      session.term = Object.keys(rest).length ? rest : null;
    }
    if (event.cwd) {
      session.cwd = event.cwd;
      session.projectName = path.basename(event.cwd);
      if (isNew) session.alias = this.folderAliasFor(event.cwd) ?? null;
    }
    if (event.transcript_path) session.transcriptPath = event.transcript_path;
    // An event proves the chat is alive: a tombstone for it is stale.
    delete session.failedAt;
    delete session.failReason;
    session.updatedAt = this.now();

    if (eventName === 'UserPromptSubmit') {
      session.status = STATUS.WORKING;
      session.unread = false;
      session.managerMessage = null;
      session.lastMessage = null;
      session.question = null;
      session.needsPermission = false;
      if (!session.promptPreview && typeof event.prompt === 'string' && event.prompt.trim()) {
        const preview = event.prompt.trim();
        session.promptPreview = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
      }
    } else if (eventName === 'Stop') {
      session.status = STATUS.DONE;
      session.unread = true;
      session.needsPermission = false;
    } else {
      session.status = STATUS.WAITING;
      session.unread = true;
      // The caller flags permission asks before humanizing the message —
      // the raw "permission to use X" is gone by the time it lands here.
      session.needsPermission = Boolean(event.permissionAsk);
      session.managerMessage = event.message ?? 'Esperando você dar uma olhada.';
    }

    this.sessions.set(sessionId, session);
    this.emit('change');
    return session;
  }

  // What the chat itself said, digested for the card. The manager's own phrase
  // stays in managerMessage for the tooltip and the voice.
  setLastMessage(sessionId, lastMessage) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastMessage = lastMessage;
    this.emit('change');
  }

  setManagerMessage(sessionId, { title, message }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (title) session.title = title;
    session.managerMessage = message;
    this.emit('change');
  }

  // The chat resumes working after a question is answered from the panel.
  markAnswered(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.question = null;
    session.managerMessage = null;
    session.status = STATUS.WORKING;
    session.unread = false;
    session.updatedAt = this.now();
    this.emit('change');
  }

  setQuestion(sessionId, question) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.question = question;
    this.emit('change');
  }

  // Closing a chat drops it for good; a new event for the same id brings it
  // back as a fresh session.
  remove(sessionId) {
    if (!this.sessions.delete(sessionId)) return;
    this.emit('change');
  }

  markAllRead() {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.unread) {
        session.unread = false;
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  // Closing a terminal kills the chat without firing any hook, so the only way
  // to know a session is gone is to compare the list against the sessions
  // Claude Code itself registers. A session is only reaped once it has been
  // seen alive there: absence on its own is not proof of death, because builds
  // without the registry never list anything.
  reconcileLiveSessions(liveIds) {
    if (!liveIds) return;
    // One live session is proof the registry works on this machine, which is
    // what makes another session's absence from it meaningful. When it lists
    // nothing, only a session seen alive earlier can be called dead.
    const registryWorks = liveIds.size > 0;
    let changed = false;
    for (const [sessionId, session] of this.sessions) {
      if (liveIds.has(sessionId)) {
        session.seenAlive = true;
        continue;
      }
      if (!isClaudeSessionId(sessionId)) continue;
      if (session.status === STATUS.FAILED) continue;
      if (!session.seenAlive && !registryWorks) continue;
      // Dying with the turn open is a failure worth showing; after the Stop
      // (or while waiting on the user) it is just a closed chat.
      if (session.status === STATUS.WORKING) {
        session.status = STATUS.FAILED;
        session.failedAt = this.now();
        session.failReason = DIED_MID_TURN;
        session.unread = false;
      } else {
        this.sessions.delete(sessionId);
      }
      changed = true;
    }
    if (changed) this.emit('change');
  }

  // The user looked at the chat (card click, terminal in front, quick reply).
  markSeen(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.seenAt = this.now();
    this.emit('change');
  }

  // Clears a tombstone; a live session is never dismissed this way.
  dismiss(sessionId) {
    if (this.sessions.get(sessionId)?.status !== STATUS.FAILED) return;
    this.sessions.delete(sessionId);
    this.emit('change');
  }

  // Chats the hooks never reported — opened before the manager was up, or
  // closed from the panel — only exist in Claude Code's own registry, so the
  // entry is built from that record. A chat the hooks already track carries
  // history the record does not, so it always wins over adoption. Idle chats
  // finished long before the rescan: done without unread describes them
  // without ringing any bell.
  adopt(records = []) {
    let added = 0;
    for (const record of records) {
      const sessionId = record?.sessionId;
      if (!isClaudeSessionId(sessionId) || this.sessions.has(sessionId)) continue;
      this.sessions.set(sessionId, {
        id: sessionId,
        cwd: record.cwd ?? '',
        projectName: record.cwd ? path.basename(record.cwd) : 'sessão',
        transcriptPath: record.transcriptPath ?? null,
        status: record.status === 'busy' ? STATUS.WORKING : STATUS.DONE,
        title: null,
        promptPreview: null,
        question: null,
        managerMessage: null,
        lastMessage: null,
        unread: false,
        updatedAt: this.now(),
        wave: null,
        term: null,
        seenAlive: true,
      });
      added++;
    }
    if (added) this.emit('change');
    return added;
  }

  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    let changed = false;
    for (const [sessionId, session] of this.sessions) {
      const expired = session.status === STATUS.FAILED
        ? this.now() - session.failedAt > TOMBSTONE_MAX_AGE_MS
        : session.updatedAt < cutoff;
      if (expired) {
        this.sessions.delete(sessionId);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  // A nickname is display-only: projectName keeps feeding the tab hunt, and
  // applyEvent recomputing it from cwd never touches the alias.
  setAlias(sessionId, alias) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.alias = String(alias ?? '').trim() || null;
    this.emit('change');
  }

  serialize() {
    return [...this.sessions.values()];
  }

  // Restores persisted sessions without emitting change (startup only).
  hydrate(sessions = []) {
    for (const session of sessions) {
      if (session?.id) this.sessions.set(session.id, { ...session });
    }
  }

  unreadCount() {
    return [...this.sessions.values()].filter((session) => session.unread).length;
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

// What the manager shows and speaks for a session: the chat's OWN nickname,
// else the plain basename. Folder defaults never appear here — they only
// baptize newborns (see the constructor).
export function displayName(session) {
  return session?.alias ?? session?.projectName;
}

// Which wave the bubble should emit: the most urgent unread state across all
// sessions — a permission ask blocks work (red), a question waits on the user
// (yellow), a finished task is news (green). null = no waves.
export function haloState(sessions) {
  let state = null;
  for (const session of sessions) {
    if (!session.unread) continue;
    if (session.needsPermission) return 'permission';
    if (session.question || session.status === STATUS.WAITING) state = 'question';
    else if (session.status === STATUS.DONE && state === null) state = 'done';
  }
  return state;
}
