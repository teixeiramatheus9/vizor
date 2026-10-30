// The Notification hook often fires BEFORE Claude Code flushes the ask entry
// to the transcript — reading immediately misses the question and the card
// shows no options. Retry a few times before giving up.
export const QUESTION_RETRY_DELAYS_MS = [0, 600, 1500];

// Stops early only on a real ask: prose ending in "?" may be the text written
// just before an AskUserQuestion that is not flushed yet, so a text question
// is accepted only if it survives the last attempt.
export async function readSnapshotWithQuestionRetry(
  read,
  { delays = QUESTION_RETRY_DELAYS_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  let snapshot = { lastAssistantMessage: null, pendingQuestion: null };
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    snapshot = await read();
    if (snapshot.pendingQuestion && snapshot.pendingQuestion.kind !== 'text') return snapshot;
  }
  return snapshot;
}
