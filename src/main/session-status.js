// The statuses a registry session can be in. Its own file, with no imports,
// so the renderer (the Agentes tab) can load it too.
export const STATUS = {
  WORKING: 'working',
  DONE: 'done',
  WAITING: 'waiting',
  FAILED: 'failed',
};

// Whether a chat is waiting on the user. Claude Code's idle "waiting for your
// input" Notification ~60 s after each Stop also sets status WAITING, but asks
// nothing: only a pending question, a permission ask or a guard ask do.
// guardAsk: truthy when the rule guard has an ask pending for this session.
export const needsYou = (session, { guardAsk = false } = {}) =>
  Boolean(session?.question || session?.needsPermission || guardAsk);
