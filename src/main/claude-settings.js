// Pure helpers for the one Claude Code setting this app exposes:
// crossSessionInbound, which decides what a session does with peer messages —
// the exact channel the quick reply uses.
//
// From Claude Code's own schema: 'accept' delivers them, 'hold' parks them for
// review without letting Claude act, 'refuse' opts the session out. Leaving it
// unset is NOT the same as 'accept': unset means mode parity, where a message
// auto-delivers only if the sender's permission-mode class matches the
// receiver's, and a sender that asserts no class (this app, which is not a
// Claude session and has no permission mode) is held whenever the receiving
// session bypasses permission prompts.
export const INBOUND_POLICIES = ['accept', 'hold', 'refuse'];

// Sentinel for "let Claude Code decide", which on disk means no key at all.
export const INBOUND_DEFAULT = 'default';

const SETTING_KEY = 'crossSessionInbound';

// The user's ~/.claude/settings.json. Missing = start empty; anything else
// that does not read as an object (a half-saved edit, a permission problem)
// is null, and callers must leave the file alone: writing hooks into {} would
// wipe the user's whole config (#165).
export function readClaudeSettingsFile(read) {
  let text;
  try {
    text = read();
  } catch (error) {
    return error?.code === 'ENOENT' ? {} : null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readInboundPolicy(settings) {
  const value = settings?.[SETTING_KEY];
  return INBOUND_POLICIES.includes(value) ? value : INBOUND_DEFAULT;
}

// Returns a NEW settings object, or null when the value is not one this app is
// allowed to write — the caller must never persist a rejected value.
export function setInboundPolicy(settings, value) {
  const allowed = value === INBOUND_DEFAULT || INBOUND_POLICIES.includes(value);
  if (!allowed) return null;
  const next = { ...(settings ?? {}) };
  if (value === INBOUND_DEFAULT) delete next[SETTING_KEY];
  else next[SETTING_KEY] = value;
  return next;
}
