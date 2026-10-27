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

// A text question ({ kind: 'text' }) leaves claude's input box free: only a
// chip question or a permission ask is a dialog that typed text would hit.
// One seen only by a Notification (unconfirmed) may be the prose before an ask
// not flushed yet, so it blocks until a Stop confirms the turn ended.
export const blocksTyping = (session) =>
  Boolean(
    session?.needsPermission ||
      (session?.question && (session.question.kind !== 'text' || session.question.unconfirmed === true)),
  );
