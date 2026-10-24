import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// 💬 comments per session (#95), in memory like the edits they point at.
// The hold rule lives here: nothing goes out while the session is waiting on
// the user (a permission prompt or a question) — typed text + Enter there
// would answer it — and one comment is in flight at a time, so they arrive
// in the order they were written.
export function createCommentStore({ now = Date.now, newId = randomUUID } = {}) {
  const store = new EventEmitter();
  const bySession = new Map(); // sessionId → Comment[]
  const byId = new Map();

  const changed = (comment) => store.emit('change', { sessionId: comment.sessionId });

  store.add = ({ sessionId, editId, text, message }) => {
    const comment = {
      id: newId(),
      sessionId,
      editId,
      text,
      message,
      status: 'queued',
      createdAt: now(),
      sentAt: null,
      channel: null,
    };
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), comment]);
    byId.set(comment.id, comment);
    changed(comment);
    return comment;
  };

  store.list = (sessionId) => [...(bySession.get(sessionId) ?? [])];

  store.nextToSend = (sessionId, sessionStatus) => {
    if (sessionStatus === 'waiting') return null;
    const comments = bySession.get(sessionId) ?? [];
    if (comments.some((comment) => comment.status === 'sending')) return null;
    return comments.find((comment) => comment.status === 'queued') ?? null;
  };

  const mark = (id, patch) => {
    const comment = byId.get(id);
    if (!comment) return;
    Object.assign(comment, patch);
    changed(comment);
  };
  store.markSending = (id) => mark(id, { status: 'sending' });
  store.markSent = (id, channel) => mark(id, { status: 'sent', channel, sentAt: now() });
  store.markFailed = (id) => mark(id, { status: 'failed' });

  store.forgetSession = (sessionId) => {
    for (const comment of bySession.get(sessionId) ?? []) byId.delete(comment.id);
    bySession.delete(sessionId);
  };

  return store;
}
