import { captureToolEvent } from './edit-capture.js';
import { editTargetPath } from './edit-tracker.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Feeds hook events into the EditTracker in the order they arrived, one chain
// per session — prompts and Stops included, so a queued edit can never land
// in the next task.
//
// What a Post diffs against must be what the disk held when the edit
// happened, not when its turn in the chain comes (seconds later, behind a
// slow git or another edit): the file is read on arrival, and a Write's own
// content is its exact "after". The "why" is retried off the chain, so a slow
// transcript never holds the next edit back.
export function createEditPipeline({
  tracker,
  readFile,
  readIndexVersion,
  readReason,
  lateReasonDelays = [600, 1500],
  sleep = defaultSleep,
}) {
  const chains = new Map(); // sessionId → tail of that session's chain
  const pending = new Set(); // chain tails and late-reason lookups in flight

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  function prefetchAfter(event) {
    if (event.hook_event_name !== 'PostToolUse') return null;
    const content = event.tool_input?.content;
    if (event.tool_name === 'Write' && typeof content === 'string') return Promise.resolve(content);
    const filePath = editTargetPath(event.tool_name, event.tool_input);
    return filePath ? readFile(filePath) : null;
  }

  async function attachLateReason(edit, event) {
    for (const delay of lateReasonDelays) {
      await sleep(delay);
      const reason = await readReason(event.transcript_path, event.tool_use_id);
      if (reason) {
        tracker.setReason(edit, reason);
        return;
      }
    }
  }

  async function handle(event, after) {
    const sessionId = event.session_id;
    if (event.hook_event_name === 'UserPromptSubmit')
      return tracker.startTask(sessionId, { prompt: event.prompt ?? null });
    if (event.hook_event_name === 'Stop') return tracker.endTask(sessionId);
    const edit = await captureToolEvent(event, {
      tracker,
      readFile: () => after,
      readIndexVersion,
      readReason,
      reasonDelays: [0],
      sleep,
    });
    if (edit && event.hook_event_name === 'PostToolUse' && !edit.reason && event.tool_use_id)
      track(attachLateReason(edit, event).catch(() => {}));
    return edit;
  }

  function push(event) {
    const sessionId = event?.session_id;
    if (!sessionId) return Promise.resolve(null);
    const after = prefetchAfter(event);
    const result = (chains.get(sessionId) ?? Promise.resolve()).then(() => handle(event, after));
    const tail = result.catch(() => {});
    chains.set(sessionId, tail);
    track(tail).then(() => {
      if (chains.get(sessionId) === tail) chains.delete(sessionId);
    });
    return result;
  }

  // Resolves once every chain and late lookup in flight has finished.
  async function settled() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return { push, settled };
}
