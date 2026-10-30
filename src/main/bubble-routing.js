import { blocksTyping } from './session-status.js';

// Where bubble clicks and panel actions go once the workspace exists (#96).
// Pure: index.js feeds the facts, tests pin the rules.

export function bubbleClickTarget({ workspaceAvailable }) {
  return workspaceAvailable ? 'workspace' : 'panel';
}

// The session the bubble opens the workspace on: what the last notice was
// about, else whatever moved last.
export function pickWorkspaceSession({ lastNoticeSessionId, sessions }) {
  if (lastNoticeSessionId && sessions.some((session) => session.id === lastNoticeSessionId))
    return lastNoticeSessionId;
  const newest = sessions.reduce((best, session) => (!best || session.updatedAt > best.updatedAt ? session : best), null);
  return newest?.id ?? null;
}

// How long a fresh "waiting" notice may still turn out to be a question: the
// question is read from the transcript up to ~2.1 s after the Notification.
const NOTICE_SETTLE_MS = 3000;

// Whether typing into claude's input box is safe right now: between turns
// (done), or idle-waiting once the notice settled with no question or
// permission prompt — never into a dialog (#96 review; shared with #95).
export function safeToTypeIdle(session, now) {
  if (!session || blocksTyping(session)) return false;
  if (session.status === 'done') return true;
  return session.status === 'waiting' && now - (session.updatedAt ?? now) > NOTICE_SETTLE_MS;
}

// A panel reply typed into a Vizor terminal follows the same rule, and only
// with that session's claude provably in front.
export function replyRoute({ session, claudeInFront, now = Date.now() }) {
  const safe = Boolean(session?.term?.VIZOR_PTY_ID) && claudeInFront && safeToTypeIdle(session, now);
  return safe ? 'pty' : 'default';
}

// Arrows + Enter only where the arrows are certain to land: one fresh
// single-select question. Anything else answers with the option's text.
export function answerRoute({ session, claudeInFront }) {
  const questions = session?.question?.questions ?? [];
  const safe =
    Boolean(session?.term?.VIZOR_PTY_ID) &&
    claudeInFront &&
    session.status === 'waiting' &&
    !session.needsPermission &&
    questions.length === 1 &&
    questions[0].multiSelect !== true;
  return safe ? 'pty' : 'default';
}

export function answerKeys(index) {
  return '\x1b[B'.repeat(Math.max(0, index));
}

// The notice policy's "is the user already looking at it": the workspace,
// focused, showing this very session. Otherwise no opinion (the terminal
// probe decides).
export function workspaceFocusOverride({ windowFocused, selectedSessionId, sessionId }) {
  return windowFocused && selectedSessionId === sessionId ? true : null;
}
