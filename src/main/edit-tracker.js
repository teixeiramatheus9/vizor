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

export const EDIT_STATUS = {
  WRITING: 'writing',
  APPLIED: 'applied',
  NOT_APPLIED: 'not-applied',
  BY_COMMAND: 'by-command', // a change no Edit/Write made (sed, formatter…)
};

// A file that keeps changing (a log, a watch build) updates its open card
// instead of piling a new one every poll (#94 review).
const COMMAND_COALESCE_MS = 30000;
const LATE_PRE_MS = 2000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const bytesOf = (text) => (typeof text === 'string' ? text.length * 2 : 0);

export function editTargetPath(toolName, toolInput) {
  return toolInput?.file_path ?? toolInput?.notebook_path ?? null;
}

export class EditTracker extends EventEmitter {
  constructor({ now = Date.now, maxTasksPerSession = 10, maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES } = {}) {
    super();
    this.now = now;
    this.maxTasksPerSession = maxTasksPerSession;
    this.maxSnapshotBytes = maxSnapshotBytes;
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
      snapshotsDropped: false,
    };
    session.tasks.push(task);
    while (session.tasks.length > this.maxTasksPerSession) session.tasks.shift();
    this.emit('task', { sessionId, ended: false });
    return task;
  }

  endTask(sessionId) {
    const task = this.currentTask(sessionId);
    if (!task || task.endedAt !== null) return null;
    this.closeTask(task);
    this.emit('task', { sessionId, ended: true });
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
    // Without an id, a Pre landing just after an applied edit of the same file
    // is that edit's own late Pre (async hooks race) — not a new edit (#102).
    if (!event.tool_use_id) {
      const last = task.edits.findLast((edit) => edit.filePath === filePath);
      if (last?.status === EDIT_STATUS.APPLIED && this.now() - last.endedAt < LATE_PRE_MS) return null;
    }
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
    this.applyContent(task, edit, { before, after, baseline, reason, note });
    this.emit('change', { sessionId, edit });
    this.enforceMemoryCeiling();
    return edit;
  }

  // A change on disk no Edit/Write hook made (#94): a card of its own, with
  // the command that probably did it as the reason.
  addCommandEdit(sessionId, { filePath, before, after, baseline = null, reason = null, note = null, uncertainOwner = false }) {
    const task = this.openTask(sessionId);
    const open = task.edits.findLast(
      (edit) =>
        edit.filePath === filePath &&
        edit.status === EDIT_STATUS.BY_COMMAND &&
        this.now() - edit.endedAt <= COMMAND_COALESCE_MS,
    );
    if (open) {
      // Same card, diffed from where it started.
      this.applyContent(task, open, { before: open.commandBefore, after, baseline: open.baseline, reason, note });
      open.uncertainOwner = open.uncertainOwner || uncertainOwner;
      this.emit('change', { sessionId, edit: open });
      this.enforceMemoryCeiling();
      return open;
    }
    const seq = task.edits.length + 1;
    const edit = this.newEdit(task, { tool_name: 'Bash', tool_use_id: `${task.id}#cmd${seq}` }, filePath);
    edit.status = EDIT_STATUS.BY_COMMAND;
    edit.uncertainOwner = uncertainOwner;
    edit.commandBefore = before ?? null;
    this.applyContent(task, edit, { before, after, baseline, reason, note });
    this.emit('change', { sessionId, edit });
    this.enforceMemoryCeiling();
    return edit;
  }

  applyContent(task, edit, { before, after, baseline, reason, note }) {
    edit.endedAt = this.now();
    edit.baseline = baseline;
    edit.reason = reason;
    edit.note = note;
    edit.hunks = [];
    edit.added = 0;
    edit.removed = 0;
    if (after !== null && after !== undefined) {
      if (before === null || before === undefined) edit.note = note ?? 'no-diff';
      else {
        const diff = diffHunks(before, after);
        if (diff) Object.assign(edit, diff);
        else edit.note = 'too-large';
      }
    }
    if (task) {
      const file = task.files.get(edit.filePath);
      if (!file) task.files.set(edit.filePath, { start: before ?? null, current: after ?? null });
      else file.current = after ?? null;
    }
  }

  // An edit still in flight (any session) accounts for a change on disk. A
  // landed edit is matched by content instead (contentsAnywhere): a time
  // window would swallow a formatter run right after it.
  // `resolve` maps a path to its real file: a hook may report a path through
  // a symlink that git reports resolved (#132).
  explains(filePath, resolve = (file) => file) {
    const target = resolve(filePath);
    for (const session of this.sessions.values())
      for (const edit of session.tasks.at(-1)?.edits ?? [])
        if (edit.status === EDIT_STATUS.WRITING && resolve(edit.filePath) === target) return true;
    return false;
  }

  // What each session's current task last saw in a file: a change on disk
  // equal to one of these is that edit's own write, not a command's.
  contentsAnywhere(filePath, resolve = (file) => file) {
    const target = resolve(filePath);
    const contents = new Set();
    for (const session of this.sessions.values())
      for (const [file, { current }] of session.tasks.at(-1)?.files ?? [])
        if (typeof current === 'string' && resolve(file) === target) contents.add(current);
    return [...contents];
  }

  snapshotBytes() {
    let total = 0;
    for (const session of this.sessions.values())
      for (const task of session.tasks)
        for (const file of task.files.values()) total += bytesOf(file.start) + bytesOf(file.current);
    return total;
  }

  // Over the ceiling, the oldest finished tasks give up their file contents
  // first; their cards and counts stay. A session's current task is never
  // touched — it is what the inspector is showing live.
  enforceMemoryCeiling() {
    let total = this.snapshotBytes();
    if (total <= this.maxSnapshotBytes) return;
    const current = new Set([...this.sessions.values()].map((session) => session.tasks.at(-1)));
    let dropped = false;
    const candidates = [...this.sessions.values()]
      .flatMap((session) => session.tasks)
      .filter((task) => !current.has(task) && !task.snapshotsDropped)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const task of candidates) {
      if (total <= this.maxSnapshotBytes) break;
      for (const file of task.files.values()) {
        total -= bytesOf(file.start) + bytesOf(file.current);
        file.start = null;
        file.current = null;
      }
      task.snapshotsDropped = true;
      dropped = true;
    }
    // Anyone caching views of those contents must let go too (#130).
    if (dropped) this.emit('evicted');
  }

  // The transcript can lag the hook; the reason then arrives after the edit.
  setReason(edit, reason) {
    edit.reason = reason;
    this.emit('change', { sessionId: edit.sessionId, edit });
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
