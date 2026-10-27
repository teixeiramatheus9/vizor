import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_TEXT,
  createReviewController,
  clampDrawerHeight,
  composerTarget,
  hunkContext,
  hunkInRange,
  nodeContext,
  nodeOfHunk,
  requestText,
  verdictAction,
} from '../src/renderer/review/review-controller.js';
import { EXPLAIN_TEXT as MAIN_EXPLAIN_TEXT } from '../src/main/review/compose.js';

describe('the review wiring helpers', () => {
  it('keeps the explain text in step with main', () => {
    expect(EXPLAIN_TEXT).toBe(MAIN_EXPLAIN_TEXT);
  });

  it('clamps the drawer between 120 px and 70% of the column', () => {
    expect(clampDrawerHeight(50, 1000)).toBe(120);
    expect(clampDrawerHeight(900, 1000)).toBe(700);
    expect(clampDrawerHeight(333, 1000)).toBe(333);
    expect(clampDrawerHeight(undefined, 1000)).toBe(300);
    expect(clampDrawerHeight(400, 100)).toBe(120);
  });

  it('writes the request as the issue or the first prompt', () => {
    expect(requestText({ kind: 'issue', number: 169, title: 'Menu', body: 'corpo' })).toBe('#169 Menu\n\ncorpo');
    expect(requestText({ kind: 'issue', number: 7, title: 'X', body: '' })).toBe('#7 X');
    expect(requestText({ kind: 'prompt', text: 'faz aí' })).toBe('faz aí');
    expect(requestText(null)).toBe('');
  });

  it('builds the compose contexts compose.js expects', () => {
    expect(hunkContext('a.js', { id: 'h', newStart: 4, newLines: 2, lines: [] })).toEqual({ kind: 'hunk', path: 'a.js', newStart: 4, newLines: 2 });
    expect(nodeContext({ id: 'a.js#run', label: 'run', files: ['a.js'], range: { startLine: 3, endLine: 9 } }))
      .toEqual({ kind: 'node', label: 'run', path: 'a.js', startLine: 3, endLine: 9 });
    expect(nodeContext({ id: 'b.js', label: 'x', files: ['b.js'], range: null })).toEqual({ kind: 'node', label: 'x', path: 'b.js' });
    // A module node is its file: no "src/b.js (src/b.js)".
    expect(nodeContext({ id: 'src/b.js', label: 'src/b.js', files: ['src/b.js'], range: null })).toEqual({ kind: 'file', path: 'src/b.js' });
  });

  it('tells whether a hunk touches a range, a deletion by its line', () => {
    expect(hunkInRange({ newStart: 5, newLines: 3 }, { startLine: 7, endLine: 9 })).toBe(true);
    expect(hunkInRange({ newStart: 10, newLines: 3 }, { startLine: 7, endLine: 9 })).toBe(false);
    expect(hunkInRange({ newStart: 8, newLines: 0 }, { startLine: 7, endLine: 9 })).toBe(true);
    expect(hunkInRange({ newStart: 1, newLines: 1 }, null)).toBe(true);
  });

  it('lights the smallest function around a hunk, else its file', () => {
    const slice = {
      nodes: [
        { id: 'a.js', files: ['a.js'], range: null },
        { id: 'a.js#outer', files: ['a.js'], range: { startLine: 1, endLine: 50 } },
        { id: 'a.js#inner', files: ['a.js'], range: { startLine: 10, endLine: 20 } },
        { id: 'b.js', files: ['b.js'], range: null },
      ],
    };
    expect(nodeOfHunk(slice, 'a.js', { newStart: 12, newLines: 2 })).toBe('a.js#inner');
    expect(nodeOfHunk(slice, 'a.js', { newStart: 30, newLines: 2 })).toBe('a.js#outer');
    expect(nodeOfHunk(slice, 'b.js', { newStart: 30, newLines: 2 })).toBe('b.js');
    expect(nodeOfHunk(slice, 'c.js', { newStart: 1, newLines: 1 })).toBeNull();
    expect(nodeOfHunk(null, 'a.js', { newStart: 1, newLines: 1 })).toBeNull();
  });

  it('writes to the picked chat while it is there, else the agent, else the first', () => {
    const sessions = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    expect(composerTarget(sessions, 'b', 'a').sessionId).toBe('b');
    expect(composerTarget(sessions, 'gone', 'a')).toMatchObject({ sessionId: 'a', sessionLabel: 'A' });
    expect(composerTarget(sessions, null, null).sessionId).toBe('a');
    expect(composerTarget([], null, null)).toMatchObject({ sessionId: null, sessionLabel: 'nenhum chat neste worktree' });
  });

  it('sends each verdict item to its detail; tsc and tests run', () => {
    expect(verdictAction('tsc')).toEqual({ verify: 'tsc' });
    expect(verdictAction('tests')).toEqual({ verify: 'tests' });
    expect(verdictAction('untested')).toEqual({ tab: 'impact' });
    expect(verdictAction('contract')).toEqual({ tab: 'changes' });
    expect(verdictAction('review')).toEqual({ tab: 'changes' });
  });
});

// Just enough DOM for the controller: elements by id, the panels, the window.
function fakeDoc() {
  const element = (extra = {}) => ({
    innerHTML: '', hidden: false, value: '', scrollTop: 0, clientHeight: 800, clientWidth: 800, style: {}, dataset: {},
    classList: (() => {
      const set = new Set();
      return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
    })(),
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], contains: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800 }),
    ...extra,
  });
  const byId = new Map();
  const panels = ['summary', 'changes', 'impact', 'live'].map((id) => element({ dataset: { reviewPanel: id } }));
  return {
    body: element(),
    activeElement: null,
    defaultView: { addEventListener() {} },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, element());
      return byId.get(id);
    },
    querySelectorAll: (selector) => (selector === '[data-review-panel]' ? panels : []),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function controllerWith(prefsByWorktree) {
  const api = {
    reviewPrefs: async (worktree, set) => (set ? {} : prefsByWorktree[worktree] ?? {}),
    reviewSummary: async () => null,
    reviewSlice: async () => ({ status: 'building', done: 0, total: 0 }),
    reviewFile: async () => null,
    onReviewChanged() {},
  };
  return createReviewController({ api, doc: fakeDoc() });
}

describe('the drawer across worktrees', () => {
  it('takes a worktree\'s saved drawer when nothing asked otherwise', async () => {
    const review = controllerWith({ '/b': { drawerOpen: false } });
    review.setContext({ worktree: '/b', sessions: [] });
    await flush();
    expect(review.drawerOpen()).toBe(false);
  });

  it('an explicit open right before moving to a worktree with its drawer closed wins', async () => {
    const review = controllerWith({ '/a': {}, '/b': { drawerOpen: false } });
    review.setContext({ worktree: '/a', sessions: [] });
    await flush();
    // A sidebar click or Ctrl+K into /b: showDrawer(), then render().
    review.setDrawer(true);
    review.setContext({ worktree: '/b', sessions: [] });
    await flush();
    expect(review.drawerOpen()).toBe(true);
  });

  it('an explicit open while the prefs load wins too', async () => {
    const review = controllerWith({ '/b': { drawerOpen: false } });
    review.setContext({ worktree: '/b', sessions: [] });
    review.setDrawer(true);
    await flush();
    expect(review.drawerOpen()).toBe(true);
  });

  it('with the Maestro holding the view, following a músico does not move the drawer', async () => {
    const review = controllerWith({ '/a': {}, '/b': { drawerOpen: false, tab: 'changes' } });
    review.setContext({ worktree: '/a', sessions: [] });
    await flush();
    review.setTab('live', { persist: false, pin: true });
    review.setContext({ worktree: '/b', sessions: [] });
    await flush();
    expect(review.drawerOpen()).toBe(true);
    expect(review.tab()).toBe('live');
  });
});

describe('coming back to a tab', () => {
  it('does not redraw a diff main answered with the same data', async () => {
    const file = { path: 'a.js', status: 'modified', tscErrors: [], hunks: [{ id: 'h1', header: '@@ -1 +1 @@', newStart: 1, newLines: 1, lines: [{ kind: '+', text: 'x', oldNo: null, newNo: 1 }] }] };
    const doc = fakeDoc();
    let html = '';
    let draws = 0;
    Object.defineProperty(doc.getElementById('changes-diff'), 'innerHTML', { get: () => html, set: (value) => { html = value; draws++; } });
    const api = {
      reviewPrefs: async (worktree, set) => (set ? {} : { tab: 'changes', openFiles: ['a.js'] }),
      reviewSummary: async () => ({ files: [{ path: 'a.js', status: 'modified' }], order: ['a.js'], verdict: [], contract: [] }),
      reviewSlice: async () => ({ status: 'building', done: 0, total: 0 }),
      reviewFile: async () => structuredClone(file),
      onReviewChanged() {},
    };
    const review = createReviewController({ api, doc });
    review.setContext({ worktree: '/a', sessions: [] });
    await flush();
    expect(html).toContain('data-hunk-id="h1"');
    const first = draws;
    review.setTab('summary');
    review.setTab('changes');
    await flush();
    expect(draws).toBe(first);
  });

  it('takes the reject prompt away after a failed reject, though the file data is the same', async () => {
    globalThis.CSS ??= { escape: (value) => value };
    const file = { path: 'a.js', status: 'modified', tscErrors: [], hunks: [{ id: 'h1', header: '@@ -1 +1 @@', newStart: 1, newLines: 1, lines: [{ kind: '+', text: 'x', oldNo: null, newNo: 1 }] }] };
    const doc = fakeDoc();
    const diff = doc.getElementById('changes-diff');
    let html = '';
    Object.defineProperty(diff, 'innerHTML', { get: () => html, set: (value) => { html = value; } });
    diff.querySelector = (selector) => (selector.includes('.hunk-head') ? { insertAdjacentHTML: (_where, markup) => { html += markup; } } : null);
    diff.querySelectorAll = () => [];
    const clicks = [];
    doc.getElementById('review-changes');
    const panels = doc.querySelectorAll('[data-review-panel]');
    const changes = panels.find((el) => el.dataset.reviewPanel === 'changes');
    changes.addEventListener = (type, handler) => { if (type === 'click') clicks.push(handler); };
    const api = {
      reviewPrefs: async (worktree, set) => (set ? {} : { tab: 'changes', openFiles: ['a.js'] }),
      reviewSummary: async () => ({ files: [{ path: 'a.js', status: 'modified' }], order: ['a.js'], verdict: [], contract: [] }),
      reviewSlice: async () => ({ status: 'building', done: 0, total: 0 }),
      reviewFile: async () => structuredClone(file),
      reviewReject: async () => ({ ok: false, error: 'o arquivo mudou; atualize' }),
      onReviewChanged() {},
    };
    createReviewController({ api, doc }).setContext({ worktree: '/a', sessions: [] });
    await flush();
    const click = (target) => clicks[0]({ target });
    const hit = (match) => ({ closest: (sel) => (match(sel) ? { dataset: match(sel), disabled: false } : null) });
    click(hit((sel) => (sel === '[data-hunk-action]' ? { hunkAction: 'reject', hunkId: 'h1' } : null)));
    await flush();
    expect(html).toContain('reject-confirm');
    click(hit((sel) => (sel === '[data-review-action]' ? { reviewAction: 'reject-yes' } : null)));
    await flush();
    expect(html).not.toContain('reject-confirm');
  });
});
