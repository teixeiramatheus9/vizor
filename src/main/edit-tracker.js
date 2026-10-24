import { EventEmitter } from 'node:events';
import { diffHunks } from './edit-hunks.js';

// Pure state behind the workspace's live diff: per session, its tasks (prompt
// to Stop) and the edits the AI made in each. No fs, no timers — the IO lives
// in edit-capture.js.
//
// The edit hooks are async, i.e. separate processes racing to the socket, so
// events arrive OUT OF ORDER: a Post can beat its own Pre, and the next
// edit's Pre (or the Stop) can beat this edit's Post. Hence: a Pre for an id
// already known is ignored, and a Post always wins over a provisional
// "not applied".

export const EDIT_STATUS = { WRITING: 'writing', APPLIED: 'applied', NOT_APPLIED: 'not-applied' };

export function editTargetPath(toolName, toolInput) {
  return toolInput?.file_path ?? toolInput?.notebook_path ?? null;
}

export class EditTracker extends EventEmitter {
  constructor({ now = Date.now, maxTasksPerSession = 10 } = {}) {
    super();
    this.now = now;
    this.maxTasksPerSession = maxTasksPerSession;
    this.sessions = new Map(); // sessionId → { tasks: Task[], taskCount: number }
  }

  startTask(sessionId, { prompt = null } = {}) {
    const session = this.sessions.get(sessionId) ?? { tasks: [], taskCount: 0 };
    this.sessions.set(sessionId, session);
    const current = session.tasks.at(-1);
    if (current && current.endedAt === null) this.closeTask(current);
    session.taskCount += 1;
    const task = {
      id: `${sessionId}:${session.taskCount}`,
      sessionId,
      prompt,
      startedAt: this.now(),
      endedAt: null,
      edits: [],
      files: new Map(),
    };
    session.tasks.push(task);
    while (session.tasks.length > this.maxTasksPerSession) session.tasks.shift();
    return task;
  }

  endTask(sessionId) {
    const task = this.currentTask(sessionId);
    if (!task || task.endedAt !== null) return null;
    this.closeTask(task);
    return task;
  }

  closeTask(task) {
    task.endedAt = this.now();
    for (const edit of task.edits)
      if (edit.status === EDIT_STATUS.WRITING) this.settle(edit, EDIT_STATUS.NOT_APPLIED);
  }

  beginEdit(event) {
    const sessionId = event?.session_id;
    const filePath = editTargetPath(event?.tool_name, event?.tool_input);
    if (!sessionId || !filePath) return null;
    if (event.tool_use_id && this.findById(sessionId, event.tool_use_id)) return null;
    const task = this.openTask(sessionId);
    // Claude edits one thing at a time: a new Pre on the same file means the
    // previous one never landed (e.g. permission denied) — unless its Post is
    // still in flight, in which case completeEdit revives it.
    for (const edit of task.edits)
      if (edit.filePath === filePath && edit.status === EDIT_STATUS.WRITING)
        this.settle(edit, EDIT_STATUS.NOT_APPLIED);
    const edit = this.newEdit(task, event, filePath);
    this.emit('change', { sessionId, edit });
    return edit;
  }

  completeEdit(event, { before, after, baseline = null, reason = null, note = null }) {
    const sessionId = event?.session_id;
    const filePath = editTargetPath(event?.tool_name, event?.tool_input);
    if (!sessionId || !filePath) return null;
    let edit = event.tool_use_id
      ? this.findById(sessionId, event.tool_use_id)
      : this.openTask(sessionId)
          .edits.findLast((candidate) => candidate.filePath === filePath && candidate.status === EDIT_STATUS.WRITING);
    const task = edit ? this.taskOf(edit) : this.openTask(sessionId);
    if (!edit) edit = this.newEdit(task, event, filePath);

    edit.status = EDIT_STATUS.APPLIED;
    edit.endedAt = this.now();
    edit.baseline = baseline;
    edit.reason = reason;
    edit.note = note;
    edit.hunks = [];
    edit.added = 0;
    edit.removed = 0;
    if (after !== null && after !== undefined) {
      if (before === null || before === undefined) edit.note = note ?? 'no-diff';
      else Object.assign(edit, diffHunks(before, after));
    }

    if (task) {
      const file = task.files.get(filePath);
      if (!file) task.files.set(filePath, { start: before ?? null, current: after ?? null });
      else file.current = after ?? null;
    }
    this.emit('change', { sessionId, edit });
    return edit;
  }

  knownContent(sessionId, filePath) {
    return this.currentTask(sessionId)?.files.get(filePath)?.current ?? null;
  }

  currentTask(sessionId) {
    return this.sessions.get(sessionId)?.tasks.at(-1) ?? null;
  }

  tasks(sessionId) {
    return [...(this.sessions.get(sessionId)?.tasks ?? [])];
  }

  forgetSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  // A task for an edit that arrives with none running: the session started
  // before the app, or its prompt event was missed.
  openTask(sessionId) {
    return this.currentTask(sessionId) ?? this.startTask(sessionId);
  }

  taskOf(edit) {
    return this.sessions.get(edit.sessionId)?.tasks.find((task) => task.id === edit.taskId) ?? null;
  }

  findById(sessionId, id) {
    for (const task of this.sessions.get(sessionId)?.tasks ?? []) {
      const edit = task.edits.find((candidate) => candidate.id === id);
      if (edit) return edit;
    }
    return null;
  }

  newEdit(task, event, filePath) {
    const seq = task.edits.length + 1;
    const edit = {
      id: event.tool_use_id ?? `${task.id}#${seq}`,
      seq,
      taskId: task.id,
      sessionId: task.sessionId,
      filePath,
      toolName: event.tool_name,
      status: EDIT_STATUS.WRITING,
      startedAt: this.now(),
      endedAt: null,
      baseline: null,
      reason: null,
      hunks: [],
      added: 0,
      removed: 0,
      note: null,
    };
    task.edits.push(edit);
    return edit;
  }

  settle(edit, status) {
    edit.status = status;
    edit.endedAt = this.now();
    this.emit('change', { sessionId: edit.sessionId, edit });
  }
}
