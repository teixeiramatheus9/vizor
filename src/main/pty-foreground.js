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
