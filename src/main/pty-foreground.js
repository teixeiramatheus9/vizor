// Whether a session's own claude process is the job in front of a terminal
// (#95 review): the only state in which typing into that terminal reaches
// claude's input box — not a shell, vim, ssh or a stopped (Ctrl+Z) claude.

// "pid (comm) state ppid pgrp session tty_nr tpgid …"; comm may contain spaces
// and parens, so fields are counted after the LAST ')'.
export function parseProcStat(text) {
  const close = String(text ?? '').lastIndexOf(')');
  if (close === -1) return null;
  const fields = text.slice(close + 2).split(' ');
  const [state, , pgrp, , ttyNr, tpgid] = fields;
  if (!state || [pgrp, ttyNr, tpgid].some((value) => !Number.isFinite(Number(value)))) return null;
  return { state, pgrp: Number(pgrp), ttyNr: Number(ttyNr), tpgid: Number(tpgid) };
}

export function inForeground({ stat, ttyRdev }) {
  const parsed = stat ? parseProcStat(stat) : null;
  if (!parsed) return false;
  if (parsed.state === 'T' || parsed.state === 't') return false; // stopped or traced
  return parsed.pgrp === parsed.tpgid && parsed.ttyNr === ttyRdev;
}

// Whether a process runs on a given terminal at all (foreground or not).
// A terminal app launched from inside a Vizor tab inherits VIZOR_PTY_ID, but
// its sessions live on another tty — they are not "in the Vizor" (#140).
// null: no way to tell.
export function onTerminal({ stat, ttyRdev }) {
  const parsed = stat ? parseProcStat(stat) : null;
  if (!parsed) return null;
  return parsed.ttyNr === ttyRdev;
}

// Whether a hook's VIZOR_PTY_ID holds (#140), cached per session and tab for a
// few seconds (#148): every Pre/PostToolUse carries the id, and the answer
// costs a scan of ~/.claude/sessions plus /proc reads. A closed tab is seen at
// once (ttyPath is in memory); a cached pid that died means the chat moved to
// another process, so it is looked up again. "Can't tell" is never cached.
export function createPtyIdentityCheck({
  ttyPath,
  ttyRdev,
  readSessionPid,
  readStat,
  pidAlive,
  now = Date.now,
  ttlMs = 3000,
}) {
  const cache = new Map();
  return function holds(sessionId, ptyId) {
    const tty = ttyPath(ptyId);
    if (!tty) return false;
    const key = `${sessionId}\0${ptyId}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs && pidAlive(hit.pid)) return hit.holds;
    cache.delete(key);
    const pid = readSessionPid(sessionId);
    if (!pid) return true; // not registered yet: keep what the hook saw
    let result;
    try {
      result = onTerminal({ stat: readStat(pid), ttyRdev: ttyRdev(tty) }) !== false;
    } catch {
      return true; // can't tell: keep what the hook saw
    }
    if (cache.size > 64) for (const [old, entry] of cache) if (now() - entry.at >= ttlMs) cache.delete(old);
    cache.set(key, { pid, holds: result, at: now() });
    return result;
  };
}
