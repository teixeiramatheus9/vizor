import { STATUS } from '../session-registry.js';
import { planProgress } from '../work/plan.js';

// The kanban's columns, in display order. Pure: the clock and the guard's
// pending asks come in as arguments.
export const COLUMNS = ['waiting', 'working', 'done', 'idle', 'failed'];

// A finished chat nobody looked at turns idle after this long (a card that
// reaches exactly this age is already idle, so the boundary nextBoundary
// reports is the instant the column really changes).
export const IDLE_AFTER_MS = 30 * 60 * 1000;

// The Stop is when a done chat was last updated, so "seen after the Stop" is
// seenAt > updatedAt.
function isIdle(session, now) {
  if (session.seenAt > session.updatedAt) return true;
  return now - session.updatedAt >= IDLE_AFTER_MS;
}

// guardAsk: truthy when the rule guard has an ask pending for this session.
export function columnOf(session, { now, guardAsk = false } = {}) {
  if (session.status === STATUS.FAILED) return 'failed';
  if (session.question || session.needsPermission || guardAsk) return 'waiting';
  if (session.status === STATUS.WORKING) return 'working';
  if (session.status === STATUS.DONE) return isIdle(session, now) ? 'idle' : 'done';
  // A Notification with no question attached: it still waits on the user.
  return 'waiting';
}

// The next instant a card changes column by itself (a fresh done going idle),
// or null. `guardAsks` (a Set of session ids) keeps cards held in waiting out.
export function nextBoundary(sessions, now, guardAsks = new Set()) {
  let next = null;
  for (const session of sessions) {
    if (columnOf(session, { now, guardAsk: guardAsks.has(session.id) }) !== 'done') continue;
    const at = session.updatedAt + IDLE_AFTER_MS;
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
    planProgress: plan?.steps?.length ? planProgress(plan.steps) : null,
    since: failed ? session.failedAt : session.updatedAt,
    question: session.question ?? null,
    branch: project?.branch ?? null,
    outside,
    thin: Boolean(session.adopted),
    actions,
  };
}
