import { describe, it, expect } from 'vitest';
import { createDailyBudget } from '../src/main/automations/budget.js';

const mk = (initial, date) => {
  let file = initial;
  let when = date;
  const b = createDailyBudget({
    file: '/f', readFile: () => { if (file === undefined) throw new Error('ENOENT'); return file; },
    writeFile: (_, text) => { file = text; }, now: () => when, capUsd: 5,
  });
  return { b, get file() { return file; }, setDay: (d) => { when = d; } };
};

describe('daily budget', () => {
  it('starts at 0 without a file and persists adds', () => {
    const t = mk(undefined, new Date(2026, 9, 27, 10));
    expect(t.b.spent()).toBe(0);
    t.b.add(1.25);
    expect(JSON.parse(t.file)).toEqual({ day: '2026-10-27', spent: 1.25 });
  });
  it('allows a run only if its cap still fits', () => {
    const t = mk(undefined, new Date(2026, 9, 27, 10));
    t.b.add(4);
    expect(t.b.allows(1)).toBe(true);
    expect(t.b.allows(1.01)).toBe(false);
  });
  it('resets at the local midnight, on load and while running', () => {
    const t = mk(JSON.stringify({ day: '2026-10-26', spent: 4.9 }), new Date(2026, 9, 27, 0, 5));
    expect(t.b.spent()).toBe(0);
    t.b.add(2);
    t.setDay(new Date(2026, 9, 28, 0, 1));
    expect(t.b.spent()).toBe(0);
    expect(t.b.allows(5)).toBe(true);
  });
  it('a negative spent in the file is corrupt', () => {
    expect(mk(JSON.stringify({ day: '2026-10-27', spent: -9 }), new Date(2026, 9, 27)).b.spent()).toBe(0);
  });
  it('a corrupt file reads as a fresh day', () => {
    expect(mk('{nope', new Date(2026, 9, 27)).b.spent()).toBe(0);
  });
});
