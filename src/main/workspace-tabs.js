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
// `sessions` come newest first, so a tab that ran several chats keeps the last;
// `resumed` (pty id → session id) covers a chat resumed in a tab that sent no
// hook event yet. Liveness is NOT read here: on a logout the chats die before
// the save. A chat is dropped only when `ended` says it was seen ending during
// the run (trackChatEnds). One chat is never saved in two tabs; the tab the
// hooks name wins over an old resume mapping.
export function tabsToSave({ terminals, sessions, ended, activeId, resumed = new Map() }) {
  const live = terminals.filter((terminal) => terminal.alive);
  const hooked = new Map();
  for (const terminal of live) {
    const session = sessions.find((candidate) => candidate.term?.VIZOR_PTY_ID === terminal.id);
    if (session) hooked.set(terminal.id, session.id);
  }
  const used = new Set(hooked.values());
  const tabs = live.map((terminal) => {
    let sessionId = hooked.get(terminal.id) ?? null;
    if (!sessionId && resumed.has(terminal.id) && !used.has(resumed.get(terminal.id))) {
      sessionId = resumed.get(terminal.id);
      used.add(sessionId);
    }
    return { cwd: terminal.cwd, sessionId: sessionId && !ended.has(sessionId) ? sessionId : null };
  });
  const active = live.findIndex((terminal) => terminal.id === activeId);
  return { tabs, active: active === -1 ? null : active };
}

// Called on each liveness check (never during a quit): a watched chat ends
// once it was seen alive and then is gone; alive again, it is back.
export function trackChatEnds({ watched, liveIds, seen, ended }) {
  if (!liveIds) return;
  for (const sessionId of watched) {
    if (liveIds.has(sessionId)) {
      seen.add(sessionId);
      ended.delete(sessionId);
    } else if (seen.has(sessionId)) ended.add(sessionId);
  }
}

// What to reopen. A chat already open somewhere else is not resumed a second
// time: two processes on one conversation would fight over its history.
export function restorePlan({ saved, liveIds, dirExists }) {
  const plan = { open: [], skipped: [] };
  if (!Array.isArray(saved?.tabs)) return plan;
  const resuming = new Set();
  saved.tabs.forEach((tab, index) => {
    if (typeof tab?.cwd !== 'string') return;
    if (!dirExists(tab.cwd)) {
      plan.skipped.push({ cwd: tab.cwd, why: 'pasta não existe' });
      return;
    }
    // The same chat twice would be two processes on one history: the second
    // tab comes back as a shell.
    const sessionId = isSessionId(tab.sessionId) && !resuming.has(tab.sessionId) ? tab.sessionId : null;
    if (sessionId && liveIds?.has(sessionId)) {
      plan.skipped.push({ cwd: tab.cwd, why: 'conversa aberta em outro lugar' });
      return;
    }
    if (sessionId) resuming.add(sessionId);
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
