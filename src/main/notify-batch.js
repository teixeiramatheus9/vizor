// Bursts of notices become one: events that do not need the user wait a short
// window and leave together, so ten chats finishing at once make ONE balloon,
// one chime and one spoken line. What needs the user (a question, a
// permission, a guard ask) never waits. Pure: timers and the sink are injected.
export const BATCH_WINDOW_MS = 3000;

// A plain 'waiting' is Claude Code's idle "waiting for your input" a minute
// after each Stop: it asks nothing, so ten of them leave together.
const URGENT_KINDS = new Set(['question', 'permission', 'guard']);

// A reminder is the same news repeated after the cooldown: it is not new, so
// it may wait and merge with whatever else is pending.
export const isUrgent = (event) => event?.urgent ?? (URGENT_KINDS.has(event?.kind) && !event?.reminder);

export function createNotifyBatch({ windowMs = BATCH_WINDOW_MS, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout, flush } = {}) {
  let pending = [];
  let timer = null;

  function release() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const events = pending;
    pending = [];
    if (events.length) flush(events);
  }

  return {
    push(event) {
      if (isUrgent(event)) {
        // The chat now needs the user: a pending "finished" for it is stale.
        if (event.sessionId != null) pending = pending.filter((item) => item.sessionId !== event.sessionId);
        if (!pending.length && timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        flush([event]);
        return;
      }
      pending.push(event);
      // One timer per window, started by the first event: a steady trickle
      // cannot postpone the notice forever.
      if (timer === null) timer = setTimer(release, windowMs);
    },
    pendingCount: () => pending.length,
    // Drops what waits (the app is quitting) without announcing it.
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
    },
  };
}

// What a flushed group says, in pt-BR: { kind, text, speech }. A lone event is
// not summarized — the caller sends it exactly as before.
export function summarizeBatch(events) {
  const count = events.length;
  const waiting = events.filter((event) => event.kind !== 'done').length;
  if (waiting === 0) {
    const text = `${count} chats terminaram`;
    return { kind: 'done', text, speech: `${count} chats terminaram.` };
  }
  if (waiting === count) {
    const text = `${count} chats esperando você`;
    return { kind: 'waiting', text, speech: `${count} chats esperando você.` };
  }
  const text = `${count} chats mudaram de estado, ${waiting} esperando você`;
  return { kind: 'waiting', text, speech: `${count} chats mudaram de estado.` };
}
