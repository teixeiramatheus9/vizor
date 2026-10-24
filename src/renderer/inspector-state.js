// What the inspector shows and whether it follows the AI. Pure: workspace.js
// feeds it events, vitest checks the rules.
//
// Following (the default) means each new edit becomes the selection. Clicking
// an older edit stops it — the view must not jump under someone reading — and
// new edits then only add up in "seguir a IA (N)".

export function initialInspector(sessionId) {
  return {
    sessionId,
    taskId: null, // null = the session's current task
    selectedId: null,
    following: true,
    seenIds: [],
    newestId: null,
    newCount: 0,
    fileRequest: 0,
  };
}

function newest(edits) {
  return edits.reduce((best, edit) => (!best || edit.startedAt >= best.startedAt ? edit : best), null);
}

export function onTask(state, task) {
  const edits = task?.edits ?? [];
  const ids = edits.map((edit) => edit.id);
  const newestId = newest(edits)?.id ?? null;
  // A new task replaced the one being read (the old edit is gone): back to
  // following instead of an empty detail.
  if (state.taskId === null && state.selectedId && !ids.includes(state.selectedId))
    return { ...state, following: true, selectedId: newestId, newestId, seenIds: ids, newCount: 0 };
  if (state.following)
    return { ...state, selectedId: newestId, newestId, seenIds: ids, newCount: 0 };
  // A past task is finished: nothing there is "new".
  if (state.taskId !== null)
    return { ...state, selectedId: state.selectedId ?? newestId, newestId, seenIds: ids, newCount: 0 };
  // Counted across refreshes until the user follows again.
  const unseen = ids.filter((id) => !state.seenIds.includes(id)).length;
  return { ...state, newestId, seenIds: ids, newCount: state.newCount + unseen };
}

export function onSelect(state, editId) {
  const following = editId === state.newestId && state.taskId === null;
  return { ...state, selectedId: editId, following, newCount: following ? 0 : state.newCount };
}

export function onFollow(state) {
  return { ...state, taskId: null, following: true, selectedId: state.newestId, newCount: 0 };
}

// A past task does not move, so it is never followed.
export function onPickTask(state, taskId) {
  return {
    ...state,
    taskId,
    following: taskId === null,
    selectedId: null,
    seenIds: [],
    newestId: null,
    newCount: 0,
  };
}

// Each file fetch gets a token; a response for an older token (another edit
// or session selected meanwhile) is dropped instead of rendered.
export function nextFileRequest(state) {
  const token = state.fileRequest + 1;
  return { state: { ...state, fileRequest: token }, token };
}

export function acceptsFile(state, token) {
  return token === state.fileRequest;
}
