import { diffability } from './edit-hunks.js';
import { editTargetPath } from './edit-tracker.js';
import { reverseEdit } from './edit-reverse.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where an edit's "before" comes from, most trustworthy first. The reverse is
// derived from the file as it is now, so a change the user made by hand
// between two AI edits can never be pinned on the AI; the git index is the
// last resort, and with nothing at all the edit says so instead of guessing.
async function resolveBefore(event, after, { tracker, readIndexVersion }) {
  const filePath = editTargetPath(event.tool_name, event.tool_input);
  const reversed = reverseEdit({ toolName: event.tool_name, toolInput: event.tool_input, after });
  if (reversed !== null) return { before: reversed, baseline: 'reverse' };
  if (event.tool_response_type === 'create') return { before: '', baseline: 'created' };
  const previous = tracker.knownContent(event.session_id, filePath);
  if (previous !== null) return { before: previous, baseline: 'previous' };
  const staged = await readIndexVersion(filePath);
  if (staged !== null) return { before: staged, baseline: 'git' };
  return { before: null, baseline: 'none' };
}

// The transcript line with the tool call can land a moment after the hook.
async function readReasonWithRetry(event, { readReason, reasonDelays, sleep }) {
  if (!event.transcript_path || !event.tool_use_id) return null;
  for (const delay of reasonDelays) {
    if (delay) await sleep(delay);
    const reason = await readReason(event.transcript_path, event.tool_use_id);
    if (reason) return reason;
  }
  return null;
}

export async function captureToolEvent(
  event,
  { tracker, readFile, readIndexVersion, readReason, reasonDelays = [0, 600, 1500], sleep = defaultSleep },
) {
  if (event?.hook_event_name === 'PreToolUse') return tracker.beginEdit(event);
  if (event?.hook_event_name !== 'PostToolUse') return null;
  const filePath = editTargetPath(event.tool_name, event.tool_input);
  if (!filePath) return null;

  const onDisk = await readFile(filePath);
  let after = onDisk;
  let note = null;
  if (onDisk === null) note = 'unreadable';
  else if (diffability(onDisk) !== 'ok') {
    note = diffability(onDisk);
    after = null;
  }
  let { before, baseline } =
    after === null ? { before: null, baseline: null } : await resolveBefore(event, after, { tracker, readIndexVersion });
  // The baseline can be as big as the git index holds; it gets the same cap.
  if (before !== null && diffability(before) !== 'ok') {
    note = diffability(before);
    before = null;
  }
  const reason = await readReasonWithRetry(event, { readReason, reasonDelays, sleep });
  return tracker.completeEdit(event, { before, after, baseline, reason, note });
}
