import { describe, it, expect, vi } from 'vitest';
import { captureToolEvent } from '../src/main/edit-capture.js';
import { EditTracker } from '../src/main/edit-tracker.js';

const FILE = '/repo/a.js';
const event = (hook, toolName, toolInput, extra = {}) => ({
  hook_event_name: hook,
  session_id: 's1',
  tool_name: toolName,
  tool_use_id: extra.id ?? 't1',
  transcript_path: '/t.jsonl',
  tool_input: { file_path: FILE, ...toolInput },
  ...extra,
});

function setup({ disk = {}, index = {}, reasons = ['why'] } = {}) {
  const tracker = new EditTracker();
  const deps = {
    tracker,
    readFile: vi.fn(async (file) => disk[file] ?? null),
    readIndexVersion: vi.fn(async (file) => index[file] ?? null),
    readReason: vi.fn(async () => reasons.shift() ?? null),
    sleep: async () => {},
  };
  return { tracker, deps };
}

describe('captureToolEvent', () => {
  it('a Pre only begins the edit', async () => {
    const { tracker, deps } = setup();
    const edit = await captureToolEvent(event('PreToolUse', 'Edit', {}), deps);
    expect(edit.status).toBe('writing');
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(tracker.currentTask('s1').edits).toHaveLength(1);
  });

  it('an Edit diffs against its own reverse, without asking git', async () => {
    const { deps } = setup({ disk: { [FILE]: 'a = 2\n' } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Edit', { old_string: 'a = 1', new_string: 'a = 2' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'reverse', added: 1, removed: 1, reason: 'why' });
    expect(deps.readIndexVersion).not.toHaveBeenCalled();
  });

  it('a Write that created the file is all additions', async () => {
    const { deps } = setup({ disk: { [FILE]: 'a\nb\n' } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Write', { content: 'a\nb\n' }, { tool_response_type: 'create' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'created', added: 2, removed: 0 });
  });

  it('a Write over a file edited earlier in the task diffs against that edit', async () => {
    const disk = { [FILE]: 'v1\n' };
    const { deps } = setup({ disk, reasons: ['one', 'two'] });
    await captureToolEvent(event('PostToolUse', 'Edit', { old_string: 'v0', new_string: 'v1' }), deps);
    disk[FILE] = 'v2\n';
    const edit = await captureToolEvent(
      event('PostToolUse', 'Write', { content: 'v2\n' }, { id: 't2', tool_response_type: 'update' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'previous', added: 1, removed: 1 });
  });

  it('a deletion Edit with nothing earlier falls back to git', async () => {
    const { deps } = setup({ disk: { [FILE]: 'keep\n' }, index: { [FILE]: 'keep\ngone\n' } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Edit', { old_string: 'gone\n', new_string: '' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'git', added: 0, removed: 1 });
  });

  it('a truncated Write still diffs from disk and git', async () => {
    const { deps } = setup({ disk: { [FILE]: 'new\n' }, index: { [FILE]: 'old\n' } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Write', { content: { truncated: 70000 } }, { tool_response_type: 'update' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'git', added: 1, removed: 1 });
  });

  it('with no baseline anywhere it says so instead of guessing', async () => {
    const { deps } = setup({ disk: { [FILE]: 'x\n' } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Write', { content: 'x\n' }, { tool_response_type: 'update' }),
      deps,
    );
    expect(edit).toMatchObject({ baseline: 'none', note: 'no-diff', hunks: [] });
  });

  it('an unreadable file is noted', async () => {
    const { deps } = setup();
    const edit = await captureToolEvent(
      event('PostToolUse', 'Edit', { old_string: 'a', new_string: 'b' }),
      deps,
    );
    expect(edit.note).toBe('unreadable');
  });

  it('an oversize file gets no diff', async () => {
    const { deps } = setup({ disk: { [FILE]: 'x'.repeat(2 * 1024 * 1024 + 1) } });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Write', { content: { truncated: 1 } }, { tool_response_type: 'update' }),
      deps,
    );
    expect(edit).toMatchObject({ note: 'too-large', hunks: [] });
  });

  it('retries the reason while the transcript catches up', async () => {
    const { deps } = setup({ disk: { [FILE]: 'b' }, reasons: [null, null, 'late why'] });
    const edit = await captureToolEvent(
      event('PostToolUse', 'Edit', { old_string: 'a', new_string: 'b' }),
      deps,
    );
    expect(edit.reason).toBe('late why');
    expect(deps.readReason).toHaveBeenCalledTimes(3);
  });

  it('ignores events that are not edit hooks', async () => {
    const { deps } = setup();
    expect(await captureToolEvent({ hook_event_name: 'Stop', session_id: 's1' }, deps)).toBeNull();
  });
});
