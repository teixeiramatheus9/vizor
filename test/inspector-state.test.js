import { describe, it, expect } from 'vitest';
import {
  acceptsFile,
  stillWanted,
  initialInspector,
  nextFileRequest,
  onFollow,
  onPickTask,
  onSelect,
  onTask,
} from '../src/renderer/inspector-state.js';

const edit = (id, startedAt) => ({ id, startedAt });
const task = (...edits) => ({ id: 's:1', edits });

describe('inspector follow-the-AI', () => {
  it('follows the newest edit, then the next one', () => {
    let state = onTask(initialInspector('s'), task(edit('a', 1), edit('b', 2)));
    expect(state).toMatchObject({ selectedId: 'b', following: true, newCount: 0 });
    state = onTask(state, task(edit('a', 1), edit('b', 2), edit('c', 3)));
    expect(state.selectedId).toBe('c');
  });

  it('stays on an older edit and counts what is new', () => {
    let state = onTask(initialInspector('s'), task(edit('a', 1), edit('b', 2)));
    state = onSelect(state, 'a');
    expect(state.following).toBe(false);
    state = onTask(state, task(edit('a', 1), edit('b', 2), edit('c', 3), edit('d', 4)));
    expect(state).toMatchObject({ selectedId: 'a', newCount: 2 });
    state = onFollow(state);
    expect(state).toMatchObject({ selectedId: 'd', following: true, newCount: 0 });
  });

  it('selecting the newest edit turns following back on', () => {
    let state = onTask(initialInspector('s'), task(edit('a', 1), edit('b', 2)));
    state = onSelect(onSelect(state, 'a'), 'b');
    expect(state.following).toBe(true);
  });

  it('a past task holds still; back to the current one follows again', () => {
    let state = onPickTask(initialInspector('s'), 's:1');
    expect(state).toMatchObject({ taskId: 's:1', following: false });
    state = onPickTask(state, null);
    expect(state).toMatchObject({ taskId: null, following: true, newCount: 0 });
  });

  it('only the latest file request may render', () => {
    const first = nextFileRequest(initialInspector('s'));
    const second = nextFileRequest(first.state);
    expect(acceptsFile(second.state, first.token)).toBe(false);
    expect(acceptsFile(second.state, second.token)).toBe(true);
  });

  it('a past task opens on its newest edit and never claims new ones', () => {
    let state = onPickTask(initialInspector('s'), 's:0');
    state = onTask(state, task(edit('x', 1), edit('y', 2)));
    expect(state).toMatchObject({ selectedId: 'y', newCount: 0, following: false });
    state = onTask(state, task(edit('x', 1), edit('y', 2)));
    expect(state.newCount).toBe(0);
  });

  it('a new task while reading an old edit goes back to following (#93 review)', () => {
    let state = onTask(initialInspector('s'), task(edit('a', 1), edit('b', 2)));
    state = onSelect(state, 'a');
    state = onTask(state, { id: 's:2', edits: [edit('c', 3)] });
    expect(state).toMatchObject({ selectedId: 'c', following: true, newCount: 0 });
  });

  it('file request tokens never repeat across sessions (#123)', () => {
    const a = nextFileRequest(initialInspector('s1'));
    const b = nextFileRequest(initialInspector('s2'));
    expect(a.token).not.toBe(b.token);
    expect(acceptsFile(b.state, a.token)).toBe(false);
  });

  it('a task response is only applied if that task is still the one picked (#121)', () => {
    let state = initialInspector('s');
    const askedFor = state.taskId; // a refresh of the current task goes out…
    state = onPickTask(state, 's:0'); // …and the user picks a past one meanwhile
    expect(stillWanted(state, askedFor)).toBe(false);
    expect(stillWanted(state, 's:0')).toBe(true);
  });
});
