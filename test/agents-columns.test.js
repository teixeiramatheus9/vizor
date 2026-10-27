import { describe, it, expect } from 'vitest';
import { COLUMNS, IDLE_AFTER_MS, columnOf, nextBoundary, sessionCard } from '../src/main/agents/columns.js';
import { STATUS } from '../src/main/session-registry.js';

const MIN = 60 * 1000;
const NOW = 10_000_000;
const session = (overrides = {}) => ({
  id: 's1',
  cwd: '/home/u/proj',
  projectName: 'proj',
  status: STATUS.WORKING,
  updatedAt: NOW - MIN,
  question: null,
  needsPermission: false,
  term: { VIZOR_PTY_ID: 'p1' },
  ...overrides,
});

describe('COLUMNS', () => {
  it('lists the five columns in display order', () => {
    expect(COLUMNS).toEqual(['waiting', 'working', 'done', 'idle', 'failed']);
  });
});

describe('columnOf', () => {
  it('puts a tombstone in failed, above everything', () => {
    const s = session({ status: STATUS.FAILED, question: 'q', needsPermission: true });
    expect(columnOf(s, { now: NOW, guardAsk: true })).toBe('failed');
  });

  it('puts a question, a permission ask or a guard ask in waiting', () => {
    expect(columnOf(session({ question: { text: 'q' } }), { now: NOW })).toBe('waiting');
    expect(columnOf(session({ needsPermission: true }), { now: NOW })).toBe('waiting');
    expect(columnOf(session(), { now: NOW, guardAsk: true })).toBe('waiting');
  });

  it('keeps a plain working chat in working', () => {
    expect(columnOf(session(), { now: NOW })).toBe('working');
  });

  it('sends a guard ask on a working session to waiting', () => {
    expect(columnOf(session({ status: STATUS.WORKING }), { now: NOW, guardAsk: true })).toBe('waiting');
  });

  it('shows a fresh done chat as done', () => {
    expect(columnOf(session({ status: STATUS.DONE }), { now: NOW })).toBe('done');
  });

  it('turns done into idle at exactly 30 min', () => {
    const at = (age) => columnOf(session({ status: STATUS.DONE, updatedAt: NOW - age }), { now: NOW });
    expect(at(IDLE_AFTER_MS - 1)).toBe('done');
    expect(at(IDLE_AFTER_MS)).toBe('idle');
    expect(at(IDLE_AFTER_MS + 1)).toBe('idle');
  });

  it('turns done into idle once seen after the Stop', () => {
    const done = (seenAt) => session({ status: STATUS.DONE, updatedAt: NOW - 5 * MIN, seenAt });
    expect(columnOf(done(NOW - MIN), { now: NOW })).toBe('idle');
    expect(columnOf(done(NOW - 10 * MIN), { now: NOW })).toBe('done');
    expect(columnOf(done(undefined), { now: NOW })).toBe('done');
  });

  it('does not let a stale seen mark hide a newer Stop', () => {
    const s = session({ status: STATUS.DONE, updatedAt: NOW - MIN, seenAt: NOW - 20 * MIN });
    expect(columnOf(s, { now: NOW })).toBe('done');
  });
});

describe('nextBoundary', () => {
  it('is the earliest instant a fresh done card goes idle', () => {
    const a = session({ id: 'a', status: STATUS.DONE, updatedAt: NOW - 10 * MIN });
    const b = session({ id: 'b', status: STATUS.DONE, updatedAt: NOW - 2 * MIN });
    expect(nextBoundary([b, a], NOW)).toBe(NOW - 10 * MIN + IDLE_AFTER_MS);
  });

  it('is null with no card that can move on its own', () => {
    const idle = session({ status: STATUS.DONE, updatedAt: NOW - 40 * MIN });
    const seen = session({ status: STATUS.DONE, updatedAt: NOW - MIN, seenAt: NOW });
    expect(nextBoundary([session(), idle, seen], NOW)).toBeNull();
    expect(nextBoundary([], NOW)).toBeNull();
  });

  it('ignores a done card held in waiting by a question', () => {
    const s = session({ status: STATUS.DONE, updatedAt: NOW - MIN, question: { text: 'q' } });
    expect(nextBoundary([s], NOW)).toBeNull();
  });

  it('ignores a done card held in waiting by a guard ask', () => {
    const s = session({ status: STATUS.DONE, updatedAt: NOW - MIN });
    expect(nextBoundary([s], NOW, new Set(['s1']))).toBeNull();
  });

  it('is strictly in the future', () => {
    const s = session({ status: STATUS.DONE, updatedAt: NOW - IDLE_AFTER_MS });
    expect(nextBoundary([s], NOW)).toBeNull();
  });
});

describe('sessionCard', () => {
  const project = { root: '/home/u/proj', branch: 'feat/x' };

  it('builds the card with the plan progress and the project', () => {
    const plan = { steps: [{ done: true }, { done: true }, { done: true }, { done: false }, { done: false }, { done: false }], approved: true };
    const card = sessionCard(session({ title: 'Corrigir bug' }), { project, plan, now: NOW });
    expect(card).toMatchObject({
      id: 's1',
      column: 'working',
      title: 'Corrigir bug',
      projectRoot: '/home/u/proj',
      avatarKey: '/home/u/proj',
      planProgress: { done: 3, total: 6, current: 3 },
      since: NOW - MIN,
      question: null,
      branch: 'feat/x',
      outside: false,
      thin: false,
    });
  });

  it('keeps a session outside the workspace with its folder as avatar key', () => {
    const card = sessionCard(session(), { project: null, now: NOW });
    expect(card).toMatchObject({ projectRoot: null, avatarKey: '/home/u/proj', branch: null, planProgress: null });
  });

  it('titles by alias, then title, then prompt, then folder', () => {
    const title = (o) => sessionCard(session(o), { now: NOW }).title;
    expect(title({ alias: 'A', title: 'T', promptPreview: 'P' })).toBe('A');
    expect(title({ title: 'T', promptPreview: 'P' })).toBe('T');
    expect(title({ promptPreview: 'P' })).toBe('P');
    expect(title({})).toBe('proj');
  });

  it('offers interrupt only to a working chat running inside Vizor', () => {
    expect(sessionCard(session(), { now: NOW }).actions).toContain('interrupt');
    const outside = sessionCard(session({ term: null }), { now: NOW });
    expect(outside.outside).toBe(true);
    expect(outside.actions).not.toContain('interrupt');
    expect(sessionCard(session({ status: STATUS.DONE }), { now: NOW }).actions).not.toContain('interrupt');
  });

  it('gives the guard buttons to a guard ask, and answer to a chat question', () => {
    expect(sessionCard(session(), { guardAsk: { id: 'g' }, now: NOW }).actions).toContain('guard');
    expect(sessionCard(session(), { guardAsk: { id: 'g' }, now: NOW }).actions).not.toContain('answer');
    const asked = sessionCard(session({ question: { text: 'q' } }), { now: NOW });
    expect(asked.column).toBe('waiting');
    expect(asked.actions).toContain('answer');
    expect(asked.question).toEqual({ text: 'q' });
  });

  it('offers approve on a permission ask', () => {
    expect(sessionCard(session({ needsPermission: true }), { now: NOW }).actions).toContain('approve');
  });

  it('gives a tombstone only dismiss, timed from the failure', () => {
    const card = sessionCard(session({ status: STATUS.FAILED, failedAt: NOW - 5 * MIN, failReason: 'x' }), { now: NOW });
    expect(card.column).toBe('failed');
    expect(card.actions).toEqual(['dismiss']);
    expect(card.since).toBe(NOW - 5 * MIN);
  });

  it('marks an adopted session without hooks as thin', () => {
    expect(sessionCard(session({ adopted: true }), { now: NOW }).thin).toBe(true);
  });

  it('only ever uses known actions', () => {
    const known = new Set(['focus', 'answer', 'interrupt', 'approve', 'guard', 'dismiss']);
    for (const o of [{}, { question: { text: 'q' } }, { needsPermission: true }, { status: STATUS.DONE }, { status: STATUS.FAILED, failedAt: 1 }]) {
      for (const a of sessionCard(session(o), { now: NOW }).actions) expect(known.has(a)).toBe(true);
    }
  });
});
