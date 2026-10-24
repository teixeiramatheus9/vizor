import { bracketedPaste, flattenForTyping } from './comment-message.js';

// Sends queued 💬 comments to their session (#95), one at a time, in order.
// Channels, best first:
//   1. the session's terminal in the Vizor, while claude runs in it — pasted
//      (multi-line stays one message), then Enter;
//   2. its NDJSON socket, newlines kept, queued behind the current turn (no
//      priority: a comment must not interrupt);
//   3. typing into its terminal window, flattened — a newline would send half.
// A failure copies the message so nothing typed is lost.
const PASTE_ENTER_DELAY_MS = 150;

export function createCommentDelivery({
  store,
  sessionOf,
  ptyUsable,
  writePty,
  sendPeer,
  typeReply,
  copyToClipboard,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const flushing = new Set();

  async function deliver(session, comment) {
    const ptyId = session.term?.VIZOR_PTY_ID;
    if (ptyId && ptyUsable(ptyId)) {
      writePty(ptyId, bracketedPaste(comment.message));
      await delay(PASTE_ENTER_DELAY_MS);
      writePty(ptyId, '\r');
      return 'pty';
    }
    if ((await sendPeer(session, comment.message)) === 'sent') return 'peer';
    if ((await typeReply(session, flattenForTyping(comment.message))) === 'sent') return 'typing';
    return null;
  }

  async function flush(sessionId) {
    if (flushing.has(sessionId)) return;
    flushing.add(sessionId);
    try {
      for (;;) {
        const session = sessionOf(sessionId);
        const comment = session ? store.nextToSend(sessionId, session.status) : null;
        if (!comment) return;
        store.markSending(comment.id);
        let channel = null;
        try {
          channel = await deliver(session, comment);
        } catch (error) {
          log(`comment delivery failed: ${error}`);
        }
        if (channel) store.markSent(comment.id, channel);
        else {
          store.markFailed(comment.id);
          copyToClipboard(comment.message);
        }
      }
    } finally {
      flushing.delete(sessionId);
    }
  }

  return { flush };
}
