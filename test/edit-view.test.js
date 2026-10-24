import { describe, it, expect } from 'vitest';
import { inlineRows, placeBanners, serializeTask, taskSummaries } from '../src/main/edit-view.js';

const edit = (id, seq, filePath, lines, extra = {}) => ({
  id,
  seq,
  filePath,
  toolName: 'Edit',
  status: 'applied',
  startedAt: 1000 + seq,
  endedAt: 2000 + seq,
  reason: `porque ${seq}`,
  note: null,
  added: lines.filter((line) => line[0] === '+').length,
  removed: lines.filter((line) => line[0] === '-').length,
  baseline: 'reverse',
  hunks: lines.length ? [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }] : [],
  ...extra,
});

describe('serializeTask', () => {
  it('shows paths relative to the worktree and keeps the hunks', () => {
    const task = {
      id: 's:1',
      prompt: 'faz x',
      startedAt: 1,
      endedAt: null,
      edits: [edit('e1', 1, '/r/src/a.js', ['+x']), edit('e2', 2, '/outro/b.js', ['+y'])],
      files: new Map(),
    };
    const view = serializeTask(task, '/r');
    expect(view.edits.map((item) => item.relPath)).toEqual(['src/a.js', 'b.js']);
    expect(view.edits[0].hunks[0].lines).toEqual(['+x']);
    expect(view).toMatchObject({ id: 's:1', prompt: 'faz x' });
  });

  it('is null without a task', () => {
    expect(serializeTask(null, '/r')).toBeNull();
  });
});

describe('taskSummaries', () => {
  it('lists newest first with short prompts', () => {
    const tasks = [
      { id: 't1', prompt: 'a'.repeat(70), startedAt: 1, edits: [1] },
      { id: 't2', prompt: 'curto', startedAt: 2, edits: [] },
    ];
    expect(taskSummaries(tasks)).toEqual([
      { id: 't2', prompt: 'curto', startedAt: 2, edits: 0 },
      { id: 't1', prompt: `${'a'.repeat(60)}…`, startedAt: 1, edits: 1 },
    ]);
  });
});

describe('inlineRows', () => {
  it('interleaves context, removals and additions with line numbers', () => {
    expect(inlineRows('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({
      note: null,
      rows: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
        { kind: 'del', oldNo: 2, newNo: null, text: 'b' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'B' },
        { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
        { kind: 'add', oldNo: null, newNo: 4, text: 'd' },
      ],
    });
  });

  it('a new file is all additions', () => {
    expect(inlineRows(null, 'x\n').rows).toEqual([{ kind: 'add', oldNo: null, newNo: 1, text: 'x' }]);
  });

  it('gives up on a huge rewrite instead of freezing', () => {
    const lines = (word) => Array.from({ length: 20000 }, (_, n) => `${word} ${n}`).join('\n');
    const started = Date.now();
    expect(inlineRows(lines('old'), lines('new'))).toEqual({ rows: [], note: 'too-large' });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('placeBanners', () => {
  const rows = inlineRows('a\nb\n}\n\nc\n', 'a\nB\n}\n\nc\nnovo\n').rows;
  const at = (text, kind) => rows.findIndex((row) => row.text === text && row.kind === kind);

  it('anchors an edit above its first meaningful added line', () => {
    const placed = placeBanners(rows, [edit('e1', 1, '/r/a', ['-b', '+B'])]);
    expect(placed.anchors).toEqual({ [at('B', 'add')]: ['e1'] });
    expect(placed.unplaced).toEqual([]);
  });

  it('anchors a pure deletion on its removed line', () => {
    expect(placeBanners(rows, [edit('e1', 1, '/r/a', ['-b'])]).anchors).toEqual({ [at('b', 'del')]: ['e1'] });
  });

  it('never anchors on punctuation or blank lines alone', () => {
    expect(placeBanners(rows, [edit('e1', 1, '/r/a', ['+}', '+'])])).toEqual({ anchors: {}, unplaced: ['e1'] });
  });

  it('lists an edit whose line is not in the file as unplaced', () => {
    expect(placeBanners(rows, [edit('e1', 1, '/r/a', ['+sumiu'])]).unplaced).toEqual(['e1']);
  });

  it('keeps edits sharing a row in seq order', () => {
    const placed = placeBanners(rows, [edit('e2', 2, '/r/a', ['+novo']), edit('e1', 1, '/r/a', ['+novo'])]);
    expect(placed.anchors).toEqual({ [at('novo', 'add')]: ['e1', 'e2'] });
  });
});
