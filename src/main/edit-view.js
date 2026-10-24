import path from 'node:path';
import { diffLines } from 'diff';

// Shapes tracked edits for the workspace inspector. Pure: the window pulls
// these through IPC, file contents never ride the state pushes.

const DIFF_TIMEOUT_MS = 250;
const PROMPT_PREVIEW_CHARS = 60;

function relativePath(filePath, worktreePath) {
  if (worktreePath) {
    const relative = path.relative(worktreePath, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  return path.basename(filePath);
}

export function serializeTask(task, worktreePath) {
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    snapshotsDropped: Boolean(task.snapshotsDropped),
    edits: task.edits.map((edit) => ({
      id: edit.id,
      seq: edit.seq,
      filePath: edit.filePath,
      relPath: relativePath(edit.filePath, worktreePath),
      toolName: edit.toolName,
      status: edit.status,
      startedAt: edit.startedAt,
      endedAt: edit.endedAt,
      reason: edit.reason,
      note: edit.note,
      added: edit.added,
      removed: edit.removed,
      baseline: edit.baseline,
      hunks: edit.hunks,
      uncertainOwner: Boolean(edit.uncertainOwner),
    })),
  };
}

export function taskSummaries(tasks) {
  return [...tasks].reverse().map((task) => {
    const prompt = task.prompt ?? '';
    return {
      id: task.id,
      prompt: prompt.length > PROMPT_PREVIEW_CHARS ? `${prompt.slice(0, PROMPT_PREVIEW_CHARS)}…` : prompt,
      startedAt: task.startedAt,
      edits: task.edits.length,
    };
  });
}

function splitLines(value) {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

// The whole file from the task start to now, as rows the inspector renders
// inline. Same 250 ms budget as the edit hunks: a full rewrite of a big file
// gives up instead of freezing the main process.
export function inlineRows(start, current) {
  const parts = diffLines(start ?? '', current ?? '', { timeout: DIFF_TIMEOUT_MS, stripTrailingCr: true });
  if (!parts) return { rows: [], note: 'too-large' };
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    for (const text of splitLines(part.value)) {
      if (part.added) rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text });
      else if (part.removed) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text });
      else rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return { rows, note: null };
}

// A line that says something: `}` or a blank line would match half the file.
const meaningful = (text) => /[\p{L}\p{N}]/u.test(text);

// Where each edit's banner goes in the file view (spec §6.2: approximate is
// fine, guessing is not): above the first row equal to the edit's first
// meaningful added line — or its first removed line, for a pure deletion.
// No match means "sem posição", never a banner over unrelated code.
export function placeBanners(rows, edits) {
  const anchors = {};
  const unplaced = [];
  for (const edit of [...edits].sort((a, b) => a.seq - b.seq)) {
    const lines = edit.hunks.flatMap((hunk) => hunk.lines);
    const added = lines.filter((line) => line[0] === '+').map((line) => line.slice(1));
    const removed = lines.filter((line) => line[0] === '-').map((line) => line.slice(1));
    const [kind, candidates] = added.length ? ['add', added] : ['del', removed];
    const target = candidates.find(meaningful);
    // The same line can be added in two places (a second `return null;`):
    // of the matching rows, take the one closest to where the hunk landed.
    const hunk = edit.hunks[0];
    const near = kind === 'add' ? hunk?.newStart : hunk?.oldStart;
    let index = -1;
    let distance = Infinity;
    if (target !== undefined)
      rows.forEach((row, at) => {
        if (row.kind !== kind || row.text !== target) return;
        const gap = Math.abs((kind === 'add' ? row.newNo : row.oldNo) - (near ?? 0));
        if (gap < distance) [index, distance] = [at, gap];
      });
    if (index === -1) unplaced.push(edit.id);
    else (anchors[index] ??= []).push(edit.id);
  }
  return { anchors, unplaced };
}

// What the inspector's file view shows for one file of a task (spec §6.1):
// the whole file as an inline diff from the task start — or, when that start
// is unknown, the whole file unchanged with a "não deu pra montar o diff" seal.
// Never all green unless the file was really created.
export function fileViewFor(task, filePath, worktreePath) {
  const edits = task?.edits.filter((edit) => edit.filePath === filePath) ?? [];
  if (!task || (!task.files.has(filePath) && !edits.length)) return { error: 'arquivo fora da tarefa' };
  const relPath = relativePath(filePath, worktreePath);
  const empty = { relPath, rows: [], anchors: {}, unplaced: [], seal: null };
  if (task.snapshotsDropped) return { ...empty, note: 'dropped' };
  const file = task.files.get(filePath);
  if (typeof file?.current !== 'string')
    return { ...empty, note: edits.findLast((edit) => edit.note)?.note ?? 'no-diff' };
  if (typeof file.start !== 'string') {
    const rows = splitLines(file.current).map((text, at) => ({ kind: 'ctx', oldNo: at + 1, newNo: at + 1, text }));
    return { ...empty, rows, note: null, seal: 'no-diff' };
  }
  const { rows, note } = inlineRows(file.start, file.current);
  if (note) return { ...empty, note };
  const view = serializeTask({ ...task, edits }, worktreePath);
  return { ...empty, rows, note: null, ...placeBanners(rows, view.edits) };
}

export function commandReason(command) {
  return command ? `$ ${command}` : 'origem desconhecida';
}
