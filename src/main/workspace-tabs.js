// The workspace's tabs across restarts (#155) and what a new tab starts with
// (#154). Pure: main feeds it the pty list, the sessions and what is alive.

// Session ids go straight into a shell command line: only a real id passes.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function terminalCommand({ kind, sessionId } = {}) {
  if (kind === 'shell') return { command: null };
  if (kind === 'claude') return { command: 'claude' };
  // Claude Code's own list, for a chat older than the ones the Vizor shows.
  if (kind === 'picker') return { command: 'claude --resume' };
  if (kind === 'resume') {
    if (!isSessionId(sessionId)) return { error: 'conversa inválida' };
    return { command: `claude --resume ${sessionId}` };
  }
  return { error: 'tipo de terminal inválido' };
}

// What to save: the live tabs in order, each with the chat running in it.
// `sessions` come newest first, so a tab that ran several chats keeps the last.
// A chat no longer alive (it ended inside its tab) is not resumed; liveIds
// null means the registry could not be read — trust the tab mapping then.
// `resumed` (pty id → session id) covers a chat resumed in a tab that sent no
// hook event yet, so the registry does not know it.
export function tabsToSave({ terminals, sessions, liveIds, activeId, resumed = new Map() }) {
  const live = terminals.filter((terminal) => terminal.alive);
  const tabs = live.map((terminal) => {
    const sessionId =
      sessions.find((candidate) => candidate.term?.VIZOR_PTY_ID === terminal.id)?.id ?? resumed.get(terminal.id);
    const running = sessionId && (liveIds === null || liveIds.has(sessionId));
    return { cwd: terminal.cwd, sessionId: running ? sessionId : null };
  });
  const active = live.findIndex((terminal) => terminal.id === activeId);
  return { tabs, active: active === -1 ? null : active };
}

// What to reopen. A chat already open somewhere else is not resumed a second
// time: two processes on one conversation would fight over its history.
export function restorePlan({ saved, liveIds, dirExists }) {
  const plan = { open: [], skipped: [] };
  if (!Array.isArray(saved?.tabs)) return plan;
  saved.tabs.forEach((tab, index) => {
    if (typeof tab?.cwd !== 'string') return;
    if (!dirExists(tab.cwd)) {
      plan.skipped.push({ cwd: tab.cwd, why: 'pasta não existe' });
      return;
    }
    const sessionId = isSessionId(tab.sessionId) ? tab.sessionId : null;
    if (sessionId && liveIds?.has(sessionId)) {
      plan.skipped.push({ cwd: tab.cwd, why: 'conversa aberta em outro lugar' });
      return;
    }
    plan.open.push({ cwd: tab.cwd, sessionId, active: index === saved.active });
  });
  return plan;
}

// Which tab each session runs in, from what exists now. A chat resumed by a
// restore keeps its old pty id until its first hook event: `restored` (new pty
// id → session id) points it at the new tab meanwhile. A pty id that matches no
// tab (the Vizor restarted) no longer counts as "in the Vizor".
export function linkTerminals(sessions, terminalIds, restored) {
  const ids = new Set(terminalIds);
  const restoredPty = new Map([...restored].map(([ptyId, sessionId]) => [sessionId, ptyId]));
  return sessions.map((session) => {
    const current = session.term?.VIZOR_PTY_ID;
    if (current && ids.has(current)) return session;
    const ptyId = restoredPty.get(session.id);
    const resumed = Boolean(ptyId) && ids.has(ptyId);
    if (!current && !resumed) return session;
    const { VIZOR_PTY_ID: _stale, ...rest } = session.term ?? {};
    if (resumed) return { ...session, term: { ...rest, VIZOR_PTY_ID: ptyId } };
    return { ...session, term: Object.keys(rest).length ? rest : null };
  });
}
