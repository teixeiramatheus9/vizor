import { describe, it, expect } from 'vitest';
import { createEditPipeline } from '../src/main/edit-pipeline.js';
import { EditTracker } from '../src/main/edit-tracker.js';

const FILE = '/repo/a.txt';
const base = { session_id: 's1', transcript_path: '/t.jsonl' };
const pre = (id, tool = 'Edit', input = {}) => ({
  ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: { file_path: FILE, ...input },
});
const post = (id, tool, input, extra = {}) => ({ ...pre(id, tool, input), hook_event_name: 'PostToolUse', ...extra });
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

function setup({ disk, index = {}, readIndexVersion, readReason, sleep } = {}) {
  const tracker = new EditTracker();
  const pipeline = createEditPipeline({
    tracker,
    readFile: async (file) => disk[file] ?? null,
    readIndexVersion: readIndexVersion ?? (async (file) => index[file] ?? null),
    readReason: readReason ?? (async () => 'why'),
    sleep: sleep ?? (async () => {}),
  });
  return { tracker, pipeline };
}

describe('edit pipeline', () => {
  it('a Write is diffed with its own content, not with what the disk holds later', async () => {
    const disk = { [FILE]: 'a\nB\nc\n' };
    const slowGit = gate();
    const { tracker, pipeline } = setup({
      disk,
      readIndexVersion: async () => {
        await slowGit.promise;
        return 'a\nb\nc\n';
      },
    });
    const write = pipeline.push(post('w', 'Write', { content: 'a\nB\nc\n' }, { tool_response_type: 'update' }));
    disk[FILE] = 'a\nB\nC\n'; // the next edit lands before the Write is processed
    const edit = pipeline.push(post('e', 'Edit', { old_string: 'c', new_string: 'C' }));
    slowGit.open();
    await Promise.all([write, edit]);
    const [w, e] = tracker.currentTask('s1').edits;
    expect(w.hunks.flatMap((hunk) => hunk.lines)).toEqual(['-b', '+B']);
    expect(e.hunks.flatMap((hunk) => hunk.lines)).toEqual(['-c', '+C']);
  });

  it('reads the disk when an edit arrives, not when its turn comes', async () => {
    const disk = { [FILE]: 'x\nkeep\n' };
    const slowGit = gate();
    const { tracker, pipeline } = setup({
      disk,
      readIndexVersion: async () => {
        await slowGit.promise;
        return 'x\nkeep\ngone\n';
      },
    });
    const deletion = pipeline.push(post('d', 'Edit', { old_string: 'gone\n', new_string: '' }));
    disk[FILE] = 'X\nkeep\n'; // a later change, not this edit's
    slowGit.open();
    await deletion;
    const [edit] = tracker.currentTask('s1').edits;
    expect(edit.hunks.flatMap((hunk) => hunk.lines)).toEqual(['-gone']);
  });

  it('task boundaries wait for the edits queued before them', async () => {
    const slowGit = gate();
    const { tracker, pipeline } = setup({
      disk: { [FILE]: 'v\n' },
      readIndexVersion: async () => {
        await slowGit.promise;
        return 'u\n';
      },
    });
    pipeline.push({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'one' });
    pipeline.push(pre('t1', 'Write'));
    const edit = pipeline.push(post('t1', 'Write', { content: 'v\n' }, { tool_response_type: 'update' }));
    const next = pipeline.push({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'two' });
    slowGit.open();
    await Promise.all([edit, next]);
    const [first, second] = tracker.tasks('s1');
    expect(first.edits.map((item) => item.status)).toEqual(['applied']);
    expect(second.edits).toEqual([]);
  });

  it('a late reason is attached afterwards without holding the queue', async () => {
    const answers = [null, 'late why'];
    const transcriptCatchesUp = gate();
    const { tracker, pipeline } = setup({
      disk: { [FILE]: 'b' },
      readReason: async () => (answers.length ? answers.shift() : 'second'),
      sleep: () => transcriptCatchesUp.promise,
    });
    const changes = [];
    tracker.on('change', ({ edit }) => changes.push(edit.reason));
    await pipeline.push(post('t1', 'Edit', { old_string: 'a', new_string: 'b' }));
    const [edit] = tracker.currentTask('s1').edits;
    expect(edit.reason).toBeNull();
    transcriptCatchesUp.open();
    await pipeline.settled();
    expect(edit.reason).toBe('late why');
    expect(changes.at(-1)).toBe('late why');
  });

  it('ignores events without a session', async () => {
    const { pipeline } = setup({ disk: {} });
    await expect(pipeline.push({ hook_event_name: 'Stop' })).resolves.toBeNull();
  });
});
