import { describe, it, expect } from 'vitest';
import { parseWhen, describeWhen, nextRun, missedRun } from '../src/main/automations/schedule.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const H = 3600000;

describe('parseWhen', () => {
  it('parses an interval in minutes or hours', () => {
    expect(parseWhen('a cada 30 min')).toEqual({ kind: 'every', minutes: 30 });
    expect(parseWhen('a cada 2 h')).toEqual({ kind: 'every', minutes: 120 });
  });
  it('parses daily, weekdays and day lists', () => {
    expect(parseWhen('todo dia às 9h')).toEqual({ kind: 'daily', at: '09:00' });
    expect(parseWhen('dias úteis às 9h30')).toEqual({ kind: 'weekdays', at: '09:30' });
    expect(parseWhen('seg, qua e sex às 18h')).toEqual({ kind: 'days', days: [1, 3, 5], at: '18:00' });
  });
  it('accepts an already structured schedule and normalizes it', () => {
    expect(parseWhen({ kind: 'days', days: [5, 1, 1], at: '07:05' })).toEqual({ kind: 'days', days: [1, 5], at: '07:05' });
    expect(parseWhen({ kind: 'every', minutes: 45 })).toEqual({ kind: 'every', minutes: 45 });
  });
  it('refuses an interval below 15 minutes', () => {
    expect(parseWhen('a cada 10 min').error).toMatch(/15/);
    expect(parseWhen({ kind: 'every', minutes: 10 }).error).toMatch(/15/);
  });
  it('refuses nonsense', () => {
    expect(parseWhen('quando eu lembrar').error).toBeTruthy();
    expect(parseWhen({ kind: 'daily', at: '25:00' }).error).toBeTruthy();
    expect(parseWhen({ kind: 'days', days: [], at: '09:00' }).error).toBeTruthy();
    expect(parseWhen(null).error).toBeTruthy();
  });
});

describe('describeWhen', () => {
  it('writes plain Portuguese', () => {
    expect(describeWhen({ kind: 'every', minutes: 120 })).toBe('a cada 2 h');
    expect(describeWhen({ kind: 'every', minutes: 30 })).toBe('a cada 30 min');
    expect(describeWhen({ kind: 'every', minutes: 90 })).toBe('a cada 90 min');
    expect(describeWhen({ kind: 'daily', at: '09:00' })).toBe('todo dia às 9h');
    expect(describeWhen({ kind: 'weekdays', at: '09:30' })).toBe('dias úteis às 9h30');
    expect(describeWhen({ kind: 'days', days: [1, 3, 5], at: '18:00' })).toBe('seg, qua e sex às 18h');
    expect(describeWhen({ kind: 'days', days: [0, 6], at: '10:00' })).toBe('dom e sáb às 10h');
    expect(describeWhen({ kind: 'days', days: [2], at: '10:00' })).toBe('ter às 10h');
  });
});

describe('nextRun', () => {
  it('every: counts from the last run, else from now', () => {
    const from = at(2026, 10, 27, 12);
    expect(nextRun({ kind: 'every', minutes: 60 }, { from })).toBe(from + H);
    expect(nextRun({ kind: 'every', minutes: 60 }, { from, lastRun: from - 30 * 60000 })).toBe(from + 30 * 60000);
  });
  it('every: an overdue run is due now', () => {
    const from = at(2026, 10, 27, 12);
    expect(nextRun({ kind: 'every', minutes: 60 }, { from, lastRun: from - 5 * H })).toBe(from);
  });
  it('daily: later today, or tomorrow once the time has passed', () => {
    const w = { kind: 'daily', at: '09:00' };
    expect(nextRun(w, { from: at(2026, 10, 27, 8) })).toBe(at(2026, 10, 27, 9));
    expect(nextRun(w, { from: at(2026, 10, 27, 9) })).toBe(at(2026, 10, 28, 9));
  });
  it('23:59 rolls to tomorrow, and across month and year ends', () => {
    const w = { kind: 'daily', at: '00:30' };
    expect(nextRun(w, { from: at(2026, 10, 27, 23, 59) })).toBe(at(2026, 10, 28, 0, 30));
    expect(nextRun(w, { from: at(2026, 10, 31, 23, 59) })).toBe(at(2026, 11, 1, 0, 30));
    expect(nextRun(w, { from: at(2026, 12, 31, 23, 59) })).toBe(at(2027, 1, 1, 0, 30));
  });
  it('weekdays skips the weekend', () => {
    const w = { kind: 'weekdays', at: '09:00' };
    // 2026-10-30 is a Friday
    expect(new Date(at(2026, 10, 30)).getDay()).toBe(5);
    expect(nextRun(w, { from: at(2026, 10, 30, 10) })).toBe(at(2026, 11, 2, 9));
    expect(nextRun(w, { from: at(2026, 10, 31, 10) })).toBe(at(2026, 11, 2, 9));
  });
  it('days picks the next listed weekday', () => {
    const w = { kind: 'days', days: [1, 3, 5], at: '18:00' };
    // Tuesday 2026-10-27 -> Wednesday
    expect(nextRun(w, { from: at(2026, 10, 27, 12) })).toBe(at(2026, 10, 28, 18));
    expect(nextRun(w, { from: at(2026, 10, 30, 19) })).toBe(at(2026, 11, 2, 18));
  });
  it('keeps the wall-clock hour across a daylight saving change', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).toBe(240); // the TZ switch must take effect
      const from = new Date(2026, 2, 7, 10).getTime();
      const next = nextRun({ kind: 'daily', at: '09:00' }, { from });
      expect(next).toBe(new Date(2026, 2, 8, 9).getTime());
      expect(next - from).toBe(22 * H); // 23 wall-clock hours minus the skipped one
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });
});

describe('missedRun', () => {
  const w = { kind: 'daily', at: '09:00' };
  it('returns the most recent missed slot inside the window', () => {
    const now = at(2026, 10, 27, 10);
    expect(missedRun(w, { lastRun: at(2026, 10, 26, 9), now })).toBe(at(2026, 10, 27, 9));
  });
  it('null when nothing was missed', () => {
    const now = at(2026, 10, 27, 10);
    expect(missedRun(w, { lastRun: at(2026, 10, 27, 9), now })).toBeNull();
    expect(missedRun(w, { lastRun: at(2026, 10, 27, 9, 5), now: at(2026, 10, 27, 8) })).toBeNull();
  });
  it('null when the slot is older than the grace window', () => {
    const now = at(2026, 10, 29, 8); // slot of the 28th at 09:00 is 23h ago; 27th is 47h
    expect(missedRun(w, { lastRun: at(2026, 10, 26, 9), now })).toBe(at(2026, 10, 28, 9));
    expect(missedRun(w, { lastRun: at(2026, 10, 26, 9), now: at(2026, 10, 29, 10), graceMs: 30 * 60000 })).toBeNull();
    expect(missedRun({ kind: 'daily', at: '09:00' }, { lastRun: at(2026, 10, 20, 9), now: at(2026, 10, 27, 8, 30) })).toBe(at(2026, 10, 26, 9));
    expect(missedRun(w, { lastRun: at(2026, 10, 20, 9), now: at(2026, 10, 27, 10), graceMs: 30 * 60000 })).toBeNull();
  });
  it('several missed slots count as one', () => {
    const now = at(2026, 10, 27, 10);
    const r = missedRun({ kind: 'every', minutes: 60 }, { lastRun: now - 5 * H - 10 * 60000, now });
    expect(r).toBe(now - 10 * 60000);
  });
  it('weekdays do not miss the weekend', () => {
    const wk = { kind: 'weekdays', at: '09:00' };
    // Fri 09:00 ran; Sunday evening open: nothing missed
    expect(missedRun(wk, { lastRun: at(2026, 10, 30, 9), now: at(2026, 11, 1, 20) })).toBeNull();
  });
  it('a never-run automação counts from its creation', () => {
    const base = { now: at(2026, 10, 27, 10), createdAt: at(2026, 10, 27, 8) };
    expect(missedRun(w, { lastRun: null, ...base })).toBe(at(2026, 10, 27, 9));
    expect(missedRun(w, { lastRun: null, now: at(2026, 10, 27, 8, 30), createdAt: base.createdAt })).toBeNull();
  });
  it('no lastRun and no createdAt: nothing missed', () => {
    expect(missedRun(w, { lastRun: null, now: at(2026, 10, 27, 10) })).toBeNull();
  });
});
