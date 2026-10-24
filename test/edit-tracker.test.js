import { describe, it, expect } from 'vitest';
import { EDIT_STATUS, EditTracker, editTargetPath } from '../src/main/edit-tracker.js';

const FILE = '/repo/a.js';
const pre = (id, file = FILE, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  tool_name: 'Edit',
  tool_use_id: id,
  tool_input: { file_path: file },
  ...extra,
});
const post = (id, file = FILE, extra = {}) => ({ ...pre(id, file, extra), hook_event_name: 'PostToolUse' });
const content = (before, after, extra = {}) => ({ before, after, baseline: 'reverse', reason: 'why', note: null, ...extra });

function makeTracker() {
  let clock = 1000;
  return new EditTracker({ now: () => clock++ });
}

describe('editTargetPath', () => {
  it('reads file_path, then notebook_path', () => {
    expect(editTargetPath('Edit', { file_path: '/a' })).toBe('/a');
    expect(editTargetPath('NotebookEdit', { notebook_path: '/n.ipynb' })).toBe('/n.ipynb');
    expect(editTargetPath('Edit', {})).toBeNull();
  });
});

describe('EditTracker', () => {
  it('pre then post gives one applied edit with counts from the hunks', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    expect(tracker.beginEdit(pre('t1')).status).toBe(EDIT_STATUS.WRITING);
    const edit = tracker.completeEdit(post('t1'), content('a\nb\n', 'a\nB\nc\n'));
    expect(edit).toMatchObject({ id: 't1', seq: 1, status: EDIT_STATUS.APPLIED, added: 2, removed: 1, reason: 'why' });
    expect(edit.hunks.length).toBeGreaterThan(0);
    expect(tracker.currentTask('s1').edits).toHaveLength(1);
  });

  it('post without a pre creates an applied edit', () => {
    const tracker = makeTracker();
    const edit = tracker.completeEdit(post('t1'), content('a', 'b'));
    expect(edit.status).toBe(EDIT_STATUS.APPLIED);
  });

  it('ignores a pre that arrives after its post', () => {
    const tracker = makeTracker();
    tracker.completeEdit(post('t1'), content('a', 'b'));
    expect(tracker.beginEdit(pre('t1'))).toBeNull();
    const [edit] = tracker.currentTask('s1').edits;
    expect(tracker.currentTask('s1').edits).toHaveLength(1);
    expect(edit.status).toBe(EDIT_STATUS.APPLIED);
  });

  it('a second pre on the same file marks the first one not applied', () => {
    const tracker = makeTracker();
    const first = tracker.beginEdit(pre('t1'));
    tracker.beginEdit(pre('t2'));
    expect(first.status).toBe(EDIT_STATUS.NOT_APPLIED);
  });

  it('a late post revives an edit wrongly marked not applied', () => {
    // async hooks race: the next edit's Pre (or the Stop) can beat this Post
    const tracker = makeTracker();
    const first = tracker.beginEdit(pre('t1'));
    tracker.beginEdit(pre('t2'));
    tracker.completeEdit(post('t1'), content('a', 'b'));
    expect(first.status).toBe(EDIT_STATUS.APPLIED);
    expect(tracker.currentTask('s1').edits).toHaveLength(2);
  });

  it('endTask marks leftover writing edits not applied', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    const edit = tracker.beginEdit(pre('t1'));
    const task = tracker.endTask('s1');
    expect(edit.status).toBe(EDIT_STATUS.NOT_APPLIED);
    expect(task.endedAt).not.toBeNull();
  });

  it('opens a task implicitly for sessions that started before the app', () => {
    const tracker = makeTracker();
    tracker.beginEdit(pre('t1'));
    expect(tracker.currentTask('s1')).not.toBeNull();
  });

  it('numbers edits per task', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    tracker.completeEdit(post('t1'), content('a', 'b'));
    tracker.startTask('s1');
    expect(tracker.completeEdit(post('t2'), content('b', 'c')).seq).toBe(1);
  });

  it('keeps at most 10 tasks per session', () => {
    const tracker = makeTracker();
    for (let n = 0; n < 11; n++) tracker.startTask('s1');
    expect(tracker.tasks('s1')).toHaveLength(10);
    expect(tracker.tasks('s1')[0].id).toBe('s1:2');
  });

  it('tracks where each file started and where it is now', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    tracker.completeEdit(post('t1'), content('v0', 'v1'));
    tracker.completeEdit(post('t2'), content('v1', 'v2'));
    expect(tracker.currentTask('s1').files.get(FILE)).toEqual({ start: 'v0', current: 'v2' });
  });

  it('knownContent is the last after within the current task only', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    tracker.completeEdit(post('t1'), content('v0', 'v1'));
    expect(tracker.knownContent('s1', FILE)).toBe('v1');
    tracker.startTask('s1');
    expect(tracker.knownContent('s1', FILE)).toBeNull();
  });

  it('a missing before means no diff, never a guessed one', () => {
    const tracker = makeTracker();
    const edit = tracker.completeEdit(post('t1'), content(null, 'v1', { baseline: 'none' }));
    expect(edit).toMatchObject({ note: 'no-diff', hunks: [], added: 0, removed: 0 });
  });

  it('a diff that gives up is marked too-large', () => {
    const tracker = makeTracker();
    const lines = (word) => Array.from({ length: 20000 }, (_, n) => `${word} ${n}`).join('\n');
    const edit = tracker.completeEdit(post('t1'), content(lines('old'), lines('new')));
    expect(edit).toMatchObject({ note: 'too-large', hunks: [], added: 0, removed: 0 });
  });

  it('a missing after keeps the capture note', () => {
    const tracker = makeTracker();
    const edit = tracker.completeEdit(post('t1'), content('v0', null, { note: 'too-large' }));
    expect(edit).toMatchObject({ note: 'too-large', hunks: [] });
  });

  it('emits change on begin and on complete', () => {
    const tracker = makeTracker();
    const seen = [];
    tracker.on('change', ({ sessionId, edit }) => seen.push([sessionId, edit.status]));
    tracker.beginEdit(pre('t1'));
    tracker.completeEdit(post('t1'), content('a', 'b'));
    expect(seen).toEqual([
      ['s1', EDIT_STATUS.WRITING],
      ['s1', EDIT_STATUS.APPLIED],
    ]);
  });

  it('without a tool_use_id, a post pairs with the last writing edit of that file', () => {
    const tracker = makeTracker();
    const begun = tracker.beginEdit(pre(undefined));
    const done = tracker.completeEdit(post(undefined), content('a', 'b'));
    expect(done).toBe(begun);
    expect(tracker.currentTask('s1').edits).toHaveLength(1);
  });

  it('forgetSession drops everything', () => {
    const tracker = makeTracker();
    tracker.beginEdit(pre('t1'));
    tracker.forgetSession('s1');
    expect(tracker.tasks('s1')).toEqual([]);
    expect(tracker.currentTask('s1')).toBeNull();
  });
});

describe('command edits (#94)', () => {
  it('records a change made by a command, with its diff and reason', () => {
    const tracker = makeTracker();
    tracker.startTask('s1');
    const edit = tracker.addCommandEdit('s1', {
      filePath: FILE, before: 'a\n', after: 'b\n', baseline: 'git', reason: '$ sed', note: null, uncertainOwner: true,
    });
    expect(edit).toMatchObject({
      status: EDIT_STATUS.BY_COMMAND, toolName: 'Bash', added: 1, removed: 1, reason: '$ sed', uncertainOwner: true, seq: 1,
    });
    expect(tracker.currentTask('s1').files.get(FILE)).toEqual({ start: 'a\n', current: 'b\n' });
  });

  it('a deleted file is a card without a diff', () => {
    const tracker = makeTracker();
    const edit = tracker.addCommandEdit('s1', { filePath: FILE, before: 'a', after: null, note: 'deleted' });
    expect(edit).toMatchObject({ note: 'deleted', hunks: [] });
  });

  it('explains a change by an edit in flight or one that just ended', () => {
    let clock = 10000;
    const tracker = new EditTracker({ now: () => clock });
    tracker.beginEdit(pre('t1', '/repo/w.js'));
    expect(tracker.explains('s1', '/repo/w.js', 10000)).toBe(true);
    tracker.completeEdit(post('t2', '/repo/e.js'), content('a', 'b'));
    expect(tracker.explains('s1', '/repo/e.js', 14000)).toBe(true);
    expect(tracker.explains('s1', '/repo/e.js', 16000)).toBe(false);
    expect(tracker.explains('s1', '/repo/other.js', 10000)).toBe(false);
  });
});

describe('memory ceiling (#94)', () => {
  it('drops snapshots of the oldest finished tasks first, never a current one', () => {
    let clock = 0;
    const tracker = new EditTracker({ now: () => ++clock, maxSnapshotBytes: 100 });
    const fill = (session, id) =>
      tracker.completeEdit({ ...post(id, `/repo/${id}.js`), session_id: session }, content('x'.repeat(20), 'y'.repeat(20)));
    tracker.startTask('s1');
    fill('s1', 'old1');
    tracker.startTask('s2');
    fill('s2', 'old2');
    tracker.startTask('s1');
    fill('s1', 'new1');
    tracker.startTask('s2');
    fill('s2', 'new2');
    const [old1, cur1] = tracker.tasks('s1');
    const [old2, cur2] = tracker.tasks('s2');
    expect(old1.snapshotsDropped).toBe(true);
    expect(old2.snapshotsDropped).toBe(true);
    expect(old1.files.get('/repo/old1.js')).toEqual({ start: null, current: null });
    expect(old1.edits[0].hunks.length).toBeGreaterThan(0);
    expect(cur1.snapshotsDropped).toBe(false);
    expect(cur2.snapshotsDropped).toBe(false);
    expect(tracker.snapshotBytes()).toBeLessThanOrEqual(2 * 2 * 40);
  });
});
