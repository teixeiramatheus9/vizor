import { bracketedPaste, flattenForTyping } from './comment-message.js';

// Sends queued 💬 comments to their session (#95), one at a time, in order.
//
// Nothing may ever type into a dialog, a shell or the wrong window, so each
// channel has a narrow condition:
//   1. the session's terminal in the Vizor — only while the session is idle
//      (between turns: no dialog can be open) AND its own claude is the job in
//      front of that terminal; checked again right before Enter;
//   2. its NDJSON socket — any time: it queues behind the current turn and
//      never types (no priority: a comment must not interrupt);
//   3. typing into its terminal window — only for a session outside the
//      Vizor, idle, on the send the user just made: never deferred, a later
//      focus steal could land anywhere.
// No channel while a turn runs → it waits for the turn to end. Otherwise the
// comment fails and the user can copy it (no automatic clipboard writes).
const PASTE_ENTER_DELAY_MS = 150;
const IDLE = ['done', 'waiting'];

export function createCommentDelivery({
  store,
  sessionOf,
  claudeInPty,
  writePty,
  sendPeer,
  typeReply,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const flushing = new Set();

  // → { outcome: 'sent'|'copied'|'hold'|'failed', channel }
  async function deliver(session, comment, { immediate }) {
    const ptyId = session.term?.VIZOR_PTY_ID ?? null;
    const idle = IDLE.includes(session.status);
    if (ptyId && idle && claudeInPty(session, ptyId)) {
      writePty(ptyId, bracketedPaste(comment.message));
      await delay(PASTE_ENTER_DELAY_MS);
      // A dialog or another program may have come up in between.
      if (!claudeInPty(session, ptyId)) return { outcome: 'failed', channel: null };
      writePty(ptyId, '\r');
      return { outcome: 'sent', channel: 'pty' };
    }
    if ((await sendPeer(session, comment.message)) === 'sent') return { outcome: 'sent', channel: 'peer' };
    if (!idle) return { outcome: 'hold', channel: null };
    if (!ptyId && immediate) {
      const typed = await typeReply(session, flattenForTyping(comment.message));
      if (typed === 'typed' || typed === 'sent') return { outcome: 'sent', channel: 'typing' };
      if (typed === 'clipboard') return { outcome: 'copied', channel: null };
    }
    return { outcome: 'failed', channel: null };
  }

  async function flush(sessionId, { immediate = false } = {}) {
    if (flushing.has(sessionId)) return;
    flushing.add(sessionId);
    try {
      for (;;) {
        const session = sessionOf(sessionId);
        const comment = session ? store.nextToSend(sessionId, session) : null;
        if (!comment) return;
        store.markSending(comment.id);
        let result = { outcome: 'failed', channel: null };
        try {
          result = await deliver(session, comment, { immediate });
        } catch (error) {
          log(`comment delivery failed: ${error}`);
        }
        if (result.outcome === 'sent') store.markSent(comment.id, result.channel);
        else if (result.outcome === 'copied') store.markCopied(comment.id);
        else if (result.outcome === 'hold') {
          store.requeue(comment.id);
          return; // tried again when the session's state changes
        } else store.markFailed(comment.id);
      }
    } finally {
      flushing.delete(sessionId);
    }
  }

  return { flush };
}
