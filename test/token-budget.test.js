import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TokenBudget } from '../src/main/token-budget.js';

async function makeBudget(nowDate) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-budget-'));
  const file = path.join(dir, 'usage.json');
  let currentDate = nowDate;
  const budget = new TokenBudget({ file, now: () => currentDate });
  return { budget, file, setDate: (date) => (currentDate = date) };
}

describe('TokenBudget', () => {
  it('accumulates usage within the same day and persists', async () => {
    const { budget, file } = await makeBudget(new Date('2026-08-18T10:00:00'));
    budget.add(1500);
    budget.add(500);
    expect(budget.usedToday()).toBe(2000);
    const reloaded = new TokenBudget({ file, now: () => new Date('2026-08-18T22:00:00') });
    expect(reloaded.usedToday()).toBe(2000);
  });

  it('rolls over to zero on a new day', async () => {
    const { budget, setDate } = await makeBudget(new Date('2026-08-18T10:00:00'));
    budget.add(99999);
    setDate(new Date('2026-08-19T00:05:00'));
    expect(budget.usedToday()).toBe(0);
  });

  it('isExceeded honors the daily budget and treats zero budget as always exceeded', async () => {
    const { budget } = await makeBudget(new Date('2026-08-18T10:00:00'));
    expect(budget.isExceeded(0)).toBe(true);
    expect(budget.isExceeded(1000)).toBe(false);
    budget.add(1000);
    expect(budget.isExceeded(1000)).toBe(true);
  });

  it('ignores negative or non-numeric usage', async () => {
    const { budget } = await makeBudget(new Date('2026-08-18T10:00:00'));
    budget.add(-50);
    budget.add(NaN);
    expect(budget.usedToday()).toBe(0);
  });
});

describe('TokenBudget events', () => {
  it("emits 'spent' with the new total after each record, and not for junk", async () => {
    const { budget } = await makeBudget(new Date('2026-08-18T10:00:00'));
    const seen = [];
    budget.on('spent', (used) => seen.push(used));
    budget.add(100);
    budget.add(0);
    budget.add('x');
    budget.add(50);
    expect(seen).toEqual([100, 150]);
  });
});
