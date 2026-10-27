// Loaded by the renderer too: no node: imports here, directly or through a dependency.
import { STATUS } from '../session-status.js';

// The kanban's columns, in display order. Pure: the clock and the guard's
// pending asks come in as arguments.
export const COLUMNS = ['waiting', 'working', 'done', 'idle', 'failed'];

// A finished chat nobody looked at turns idle after this long (a card that
// reaches exactly this age is already idle, so the boundary nextBoundary
// reports is the instant the column really changes).
export const IDLE_AFTER_MS = 30 * 60 * 1000;

// When the turn ended: the registry's Stop time, else (adopted or older
// sessions) the last update. Never the idle Notification's later bump.
export const stopTimeOf = (session) => session.stoppedAt ?? session.updatedAt;

function isIdle(session, now) {
  const stop = stopTimeOf(session);
  if (session.seenAt > stop) return true;
  return now - stop >= IDLE_AFTER_MS;
}

// Claude Code's "waiting for your input" ~60 s after each Stop asks nothing:
// only a question, a permission or a guard ask make a chat wait on the user.
const asksTheUser = (session, guardAsk) => Boolean(session.question || session.needsPermission || guardAsk);

// guardAsk: truthy when the rule guard has an ask pending for this session.
export function columnOf(session, { now, guardAsk = false } = {}) {
  if (session.status === STATUS.FAILED) return 'failed';
  if (asksTheUser(session, guardAsk)) return 'waiting';
  if (session.status === STATUS.WORKING) return 'working';
  // Done, or a Notification with nothing asked: the chat is just finished.
  return isIdle(session, now) ? 'idle' : 'done';
}

// The next instant a card changes column by itself (a fresh done going idle),
// or null. `guardAsks` (a Set of session ids) keeps cards held in waiting out.
export function nextBoundary(sessions, now, guardAsks = new Set()) {
  let next = null;
  for (const session of sessions) {
    if (columnOf(session, { now, guardAsk: guardAsks.has(session.id) }) !== 'done') continue;
    const at = stopTimeOf(session) + IDLE_AFTER_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

// project: { root, branch } of the workspace project the chat's folder belongs
// to, or null for a chat outside the workspace. plan: the tracker's
// { steps, approved } or null.
export function sessionCard(session, { project = null, plan = null, guardAsk = null, now } = {}) {
  const column = columnOf(session, { now, guardAsk: Boolean(guardAsk) });
  const outside = !session.term?.VIZOR_PTY_ID;
  const failed = column === 'failed';

  const actions = [];
  if (failed) {
    actions.push('dismiss');
  } else {
    actions.push('focus');
    if (guardAsk) actions.push('guard');
    else if (session.needsPermission) actions.push('approve');
    else if (session.question) actions.push('answer');
    // Esc goes to the chat's own pty, which only Vizor's chats have.
    if (!outside && session.status === STATUS.WORKING) actions.push('interrupt');
  }

  return {
    id: session.id,
    column,
    title: session.alias ?? session.title ?? session.promptPreview ?? session.projectName,
    projectRoot: project?.root ?? null,
    avatarKey: project?.root ?? session.cwd ?? null,
    planProgress: plan?.steps?.length ? `${plan.steps.filter((step) => step.done).length}/${plan.steps.length}` : null,
    since: failed ? session.failedAt : column === 'done' || column === 'idle' ? stopTimeOf(session) : session.updatedAt,
    question: session.question ?? null,
    branch: project?.branch ?? null,
    outside,
    thin: Boolean(session.adopted),
    actions,
  };
}
