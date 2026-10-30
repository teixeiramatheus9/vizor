// Pure model of the Claude usage windows (5 h and weekly): folds status-line
// readings into a state, says which notices are due, and splits the 5 h gain
// between chats by their cost. No I/O; every function returns new state.
export const WINDOWS = ['fiveHour', 'sevenDay'];
const API_KEY = { fiveHour: 'five_hour', sevenDay: 'seven_day' };
const FIVE_H = 5 * 3600_000;
const SAME_WINDOW_MS = 120_000;
const HISTORY_CAP = 300;
const FIRED_CAP = 24;

export function emptyState() {
  return { windows: { fiveHour: null, sevenDay: null }, sessions: {}, fired: {} };
}

const keyOf = (w, resetsAt) => `${w}:${resetsAt}`;
const warnAtOf = (s) => (Number.isFinite(s?.warnAt) ? s.warnAt : 80);
const enabled = (settings, w) => settings?.[w] !== false;
const isFired = (st, w, resetsAt, kind) => !!st.fired[keyOf(w, resetsAt)]?.[kind];

function markFired(fired, w, resetsAt, kind) {
  const k = keyOf(w, resetsAt);
  const next = { ...fired };
  delete next[k]; // re-insert so the newest keys sit last
  next[k] = { ...fired[k], [kind]: true };
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - FIRED_CAP))) delete next[old];
  return next;
}

const event = (kind, window, win) => ({ kind, window, pct: win.pct, resetsAt: win.resetsAt });

// Folds one window's reading; returns the new window (or the old one untouched).
function foldWindow(old, raw, now) {
  const pct = Number(raw?.used_percentage);
  const resetsAt = Number(raw?.resets_at) * 1000;
  if (!Number.isFinite(pct) || !Number.isFinite(resetsAt) || resetsAt <= now) return { win: old };
  if (!old || Math.abs(resetsAt - old.resetsAt) > SAME_WINDOW_MS) {
    return { win: { pct, resetsAt, seenAt: now, startedAt: now, history: [[now, pct]] }, fresh: true, prev: old };
  }
  const next = Math.max(old.pct, pct);
  const history = next === old.pct ? old.history : [...old.history, [now, next]].slice(-HISTORY_CAP);
  return { win: { ...old, pct: next, seenAt: now, history } };
}

function foldSession(sessions, r, win5, now) {
  if (!r.sessionId || !Number.isFinite(r.costUsd)) return sessions;
  const wkey = win5 ? String(win5.resetsAt) : null;
  const prev = sessions[r.sessionId];
  let s;
  if (prev && prev.windowKey === wkey) {
    s = { ...prev, cwd: r.cwd ?? prev.cwd, lastCost: r.costUsd, lastAt: now };
  } else {
    // First in this window: count from the last reading before it began, if any.
    const before = prev && win5 && prev.lastAt < win5.resetsAt - FIVE_H;
    s = {
      cwd: r.cwd ?? prev?.cwd ?? null,
      firstCost: before ? prev.lastCost : r.costUsd,
      lastCost: r.costUsd,
      firstAt: before ? prev.lastAt : now,
      lastAt: now,
      windowKey: wkey,
    };
  }
  return { ...sessions, [r.sessionId]: s };
}

export function reduce(state, reading, now, settings) {
  const events = [];
  const windows = { ...state.windows };
  let fired = state.fired;
  for (const w of WINDOWS) {
    const raw = reading?.rateLimits?.[API_KEY[w]];
    if (!raw) continue;
    const { win, fresh, prev } = foldWindow(windows[w], raw, now);
    if (win === windows[w]) continue;
    const on = enabled(settings, w);
    // A new window proves the old one is over: close its pending notice now.
    if (fresh && prev && on) {
      const st = { fired };
      if (prev.pct >= 100 && !isFired(st, w, prev.resetsAt, 'back')) {
        events.push(event('limit-back', w, prev));
        fired = markFired(fired, w, prev.resetsAt, 'back');
      }
    }
    windows[w] = win;
    if (!on) continue;
    const st = { fired };
    if (win.pct >= 100) {
      if (!isFired(st, w, win.resetsAt, 'out')) {
        events.push(event('limit-out', w, win));
        fired = markFired(fired, w, win.resetsAt, 'out');
      }
    } else if (win.pct >= warnAtOf(settings) && !isFired(st, w, win.resetsAt, 'near')) {
      events.push(event('limit-near', w, win));
      fired = markFired(fired, w, win.resetsAt, 'near');
    }
  }
  const sessions = foldSession(state.sessions, reading ?? {}, windows.fiveHour, now);
  return { state: { windows, sessions, fired }, events };
}

// Does this window still owe a notice at its reset?
function pendingKind(state, w, win, settings) {
  if (!enabled(settings, w)) return null;
  if (win.pct >= 100) return isFired(state, w, win.resetsAt, 'back') ? null : 'limit-back';
  if (!settings?.resetNotice) return null;
  return isFired(state, w, win.resetsAt, 'reset') ? null : 'limit-reset';
}

export function due(state, now, settings) {
  const events = [];
  const windows = { ...state.windows };
  let fired = state.fired;
  for (const w of WINDOWS) {
    const win = windows[w];
    if (!win || win.resetsAt > now) continue;
    const kind = pendingKind({ fired }, w, win, settings);
    if (kind) {
      events.push(event(kind, w, win));
      fired = markFired(fired, w, win.resetsAt, kind === 'limit-back' ? 'back' : 'reset');
    }
    windows[w] = null;
  }
  return { state: { ...state, windows, fired }, events };
}

export function nextAlarm(state, settings) {
  let best = null;
  for (const w of WINDOWS) {
    const win = state.windows[w];
    if (!win || !pendingKind(state, w, win, settings)) continue;
    if (best === null || win.resetsAt < best) best = win.resetsAt;
  }
  return best;
}

// 5 h window only: each chat's slice of the gain, weighted by its in-window spend.
export function shares(state) {
  const win = state.windows.fiveHour;
  if (!win) return { chats: [], outside: 0 };
  const key = String(win.resetsAt);
  const base = win.history[0]?.[1] ?? 0;
  const gain = Math.max(0, win.pct - base);
  const rows = Object.entries(state.sessions)
    .filter(([, s]) => s.windowKey === key)
    .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, spend: Math.max(0, s.lastCost - s.firstCost) }));
  const total = rows.reduce((a, r) => a + r.spend, 0);
  const chats = rows.map((r) => ({ sessionId: r.sessionId, cwd: r.cwd, pct: total > 0 ? (r.spend / total) * gain : 0 }));
  const sum = chats.reduce((a, c) => a + c.pct, 0);
  return { chats, outside: Math.max(0, win.pct - sum) };
}
