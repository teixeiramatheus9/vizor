import { describe, it, expect } from 'vitest';
import { emptyState, reduce, due, nextAlarm, shares } from '../src/main/limits/limits-model.js';

const H = 3600_000;
const T0 = 1_800_000_000_000;
const S = { fiveHour: true, sevenDay: true, warnAt: 80, resetNotice: false };
const rl = (pct, resetsAtMs, key = 'five_hour') => ({
  [key]: { used_percentage: pct, resets_at: resetsAtMs / 1000 },
});
const read = (state, rateLimits, now, over = {}, settings = S) =>
  reduce(state, { sessionId: 'a', cwd: '/p', costUsd: null, rateLimits, ...over }, now, settings);
const kinds = (r) => r.events.map((e) => e.kind);

describe('limits-model', () => {
  it('near fires once at warnAt and not again on a lower or equal reading', () => {
    const R = T0 + 4 * H;
    let r = read(emptyState(), rl(79, R), T0);
    expect(kinds(r)).toEqual([]);
    r = read(r.state, rl(80, R), T0 + 1000);
    expect(r.events).toEqual([{ kind: 'limit-near', window: 'fiveHour', pct: 80, resetsAt: R }]);
    expect(kinds(read(r.state, rl(80, R), T0 + 2000))).toEqual([]);
    expect(kinds(read(r.state, rl(85, R), T0 + 3000))).toEqual([]);
    expect(kinds(read(r.state, rl(70, R), T0 + 4000))).toEqual([]);
  });

  it('out fires at 100 and arms the alarm at resetsAt', () => {
    const R = T0 + 2 * H;
    const r = read(emptyState(), rl(100, R), T0);
    expect(kinds(r)).toEqual(['limit-out']);
    expect(kinds(read(r.state, rl(100, R), T0 + 1))).toEqual([]);
    expect(nextAlarm(r.state, S)).toBe(R);
  });

  it('due fires back once and clears the window', () => {
    const R = T0 + 2 * H;
    const r = read(emptyState(), rl(100, R), T0);
    expect(kinds(due(r.state, R - 1, S))).toEqual([]);
    const d = due(r.state, R, S);
    expect(d.events).toEqual([{ kind: 'limit-back', window: 'fiveHour', pct: 100, resetsAt: R }]);
    expect(d.state.windows.fiveHour).toBeNull();
    expect(kinds(due(d.state, R + 1, S))).toEqual([]);
    expect(nextAlarm(d.state, S)).toBeNull();
  });

  it('reset notice only when enabled and the window was not exhausted', () => {
    const R = T0 + 2 * H;
    const on = { ...S, resetNotice: true };
    const r = read(emptyState(), rl(30, R), T0, {}, on);
    expect(nextAlarm(r.state, on)).toBe(R);
    expect(nextAlarm(r.state, S)).toBeNull();
    expect(kinds(due(r.state, R, S))).toEqual([]);
    expect(due(r.state, R, on).events).toEqual([
      { kind: 'limit-reset', window: 'fiveHour', pct: 30, resetsAt: R },
    ]);
    const out = read(emptyState(), rl(100, R), T0, {}, on);
    expect(kinds(due(out.state, R, on))).toEqual(['limit-back']);
  });

  it('resets_at jitter under 120 s is the same window', () => {
    const R = T0 + 4 * H;
    let r = read(emptyState(), rl(80, R), T0);
    r = read(r.state, rl(85, R + 90_000), T0 + 1000);
    expect(r.events).toEqual([]);
    expect(r.state.windows.fiveHour.resetsAt).toBe(R);
    expect(r.state.windows.fiveHour.pct).toBe(85);
    r = read(r.state, rl(5, R + 5 * H), T0 + 2000);
    expect(r.state.windows.fiveHour.pct).toBe(5);
    expect(r.state.windows.fiveHour.resetsAt).toBe(R + 5 * H);
  });

  it('an older lower reading never lowers the window', () => {
    const R = T0 + 4 * H;
    let r = read(emptyState(), rl(60, R), T0);
    const before = JSON.stringify(r.state);
    r = read(r.state, rl(40, R), T0 + 1000);
    expect(r.state.windows.fiveHour.pct).toBe(60);
    expect(r.state.windows.fiveHour.history).toEqual([[T0, 60]]);
    expect(JSON.stringify(emptyState())).not.toBe(before);
  });

  it('a disabled window updates but emits nothing', () => {
    const R = T0 + 2 * H;
    const off = { ...S, fiveHour: false };
    const r = read(emptyState(), rl(100, R), T0, {}, off);
    expect(r.events).toEqual([]);
    expect(r.state.windows.fiveHour.pct).toBe(100);
    expect(nextAlarm(r.state, off)).toBeNull();
    expect(due(r.state, R, off).events).toEqual([]);
    const seven = read(emptyState(), rl(90, R, 'seven_day'), T0, {}, off);
    expect(kinds(seven)).toEqual(['limit-near']);
  });

  it('history appends on change and caps at 300', () => {
    const R = T0 + 4 * H;
    let st = emptyState();
    for (let i = 0; i < 350; i++) st = read(st, rl(1 + i * 0.1, R), T0 + i).state;
    st = read(st, rl(1 + 349 * 0.1, R), T0 + 999).state;
    const h = st.windows.fiveHour.history;
    expect(h).toHaveLength(300);
    expect(h[299][0]).toBe(T0 + 349);
    expect(h[0][0]).toBe(T0 + 50);
  });

  it('does not mutate its input', () => {
    const R = T0 + 4 * H;
    const st = read(emptyState(), rl(10, R), T0, { costUsd: 1 }).state;
    const snap = JSON.stringify(st);
    read(st, rl(90, R), T0 + 1, { costUsd: 2 });
    due(st, R + 1, S);
    expect(JSON.stringify(st)).toBe(snap);
  });

  it('shares split the window gain by in-window spend and never go negative', () => {
    const R = T0 + 4 * H;
    let st = emptyState();
    st = read(st, rl(10, R), T0, { sessionId: 'a', cwd: '/a', costUsd: 1 }).state;
    st = read(st, rl(10, R), T0, { sessionId: 'b', cwd: '/b', costUsd: 5 }).state;
    st = read(st, rl(40, R), T0 + 1000, { sessionId: 'a', cwd: '/a', costUsd: 2 }).state; // +1
    st = read(st, rl(40, R), T0 + 1000, { sessionId: 'b', cwd: '/b', costUsd: 8 }).state; // +3
    const s = shares(st);
    const byId = Object.fromEntries(s.chats.map((c) => [c.sessionId, c]));
    expect(byId.a.pct).toBeCloseTo(7.5);
    expect(byId.b.pct).toBeCloseTo(22.5);
    expect(byId.a.cwd).toBe('/a');
    expect(s.outside).toBeCloseTo(10);
    expect(s.chats.every((c) => c.pct >= 0) && s.outside >= 0).toBe(true);
    expect(shares(emptyState())).toEqual({ chats: [], outside: 0 });
  });

  it('a missing cost leaves the session cost alone', () => {
    const R = T0 + 4 * H;
    let st = read(emptyState(), rl(10, R), T0, { costUsd: 1 }).state;
    st = read(st, rl(20, R), T0 + 1, { costUsd: null }).state;
    expect(st.sessions.a.lastCost).toBe(1);
    expect(read(emptyState(), rl(10, R), T0, { sessionId: 'z', costUsd: null }).state.sessions.z).toBeUndefined();
  });

  it('a chat seen before the window counts from that reading; one first seen inside counts from its first in-window reading', () => {
    const R1 = T0 + H;
    const R2 = R1 + 5 * H; // second window starts at R1
    let st = emptyState();
    st = read(st, rl(50, R1), T0, { sessionId: 'old', costUsd: 10 }).state;
    // new window; 'old' keeps working, 'new' appears
    st = read(st, rl(5, R2), R1 + 1000, { sessionId: 'new', costUsd: 100 }).state;
    st = read(st, rl(20, R2), R1 + 2000, { sessionId: 'old', costUsd: 13 }).state; // 3 since before window
    st = read(st, rl(30, R2), R1 + 3000, { sessionId: 'new', costUsd: 102 }).state; // 2 since first in-window
    expect(st.sessions.old.firstCost).toBe(10);
    expect(st.sessions.new.firstCost).toBe(100);
    const byId = Object.fromEntries(shares(st).chats.map((c) => [c.sessionId, c.pct]));
    expect(byId.old).toBeCloseTo(15); // gain 25 (30 - 5), 3/5
    expect(byId.new).toBeCloseTo(10);
    expect(shares(st).outside).toBeCloseTo(5);
  });
});
