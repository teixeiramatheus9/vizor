import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRunner } from '../src/main/automations/runner.js';

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  };
}
const a = { id: 'a1', capUsd: 1 };
const setup = () => {
  const s = fakeSpawn();
  const t = fakeTimers();
  const kills = [];
  const runner = createRunner({ spawn: s.spawn, now: () => 1000, setTimer: t.setTimer, clearTimer: t.clearTimer, kill: (pid, sig) => kills.push([pid, sig]) });
  return { ...s, ...t, kills, runner };
};
const finish = (child, json, code = 0) => { child.stdout.emit('data', JSON.stringify(json)); child.emit('close', code); };

describe('runner', () => {
  it('spawns detached, without a shell, with the given args/env/cwd', async () => {
    const { runner, calls } = setup();
    const p = runner.run({ automation: a, args: ['-p', '/x'], cwd: '/w', env: { A: '1' }, timeoutMs: 5000 });
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual(['-p', '/x']);
    expect(calls[0].opts).toMatchObject({ detached: true, cwd: '/w', env: { A: '1' }, shell: false });
    finish(calls[0].child, { is_error: false, subtype: 'success', result: 'feito', total_cost_usd: 0.2, num_turns: 3, duration_ms: 900, session_id: 's', permission_denials: [{}, {}] });
    expect(await p).toMatchObject({ status: 'ok', result: 'feito', costUsd: 0.2, numTurns: 3, durationMs: 900, sessionId: 's', permissionDenials: 2 });
  });

  it('is_error true is failed', async () => {
    const { runner, calls } = setup();
    const p = runner.run({ automation: a, args: [], timeoutMs: 1 });
    finish(calls[0].child, { is_error: true, subtype: 'error_during_execution', result: 'x', total_cost_usd: 0.1 }, 1);
    expect((await p).status).toBe('failed');
  });

  it('error_max_budget_usd on exit 1 is over-cap, keeping the reported cost', async () => {
    const { runner, calls } = setup();
    const p = runner.run({ automation: a, args: [], timeoutMs: 1 });
    finish(calls[0].child, { is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.153 }, 1);
    expect(await p).toMatchObject({ status: 'over-cap', costUsd: 0.153 });
  });

  it('no parsable JSON is failed; stderr is capped at 64 KB', async () => {
    const { runner, calls } = setup();
    const p = runner.run({ automation: a, args: [], timeoutMs: 1 });
    calls[0].child.stderr.emit('data', 'e'.repeat(100000));
    calls[0].child.stdout.emit('data', 'garbage');
    calls[0].child.emit('close', 1);
    const r = await p;
    expect(r.status).toBe('failed');
    expect(r.stderr.length).toBe(64 * 1024);
  });

  it('timeout kills the process group (SIGTERM then SIGKILL) and counts the whole cap', async () => {
    const { runner, calls, timers, kills } = setup();
    const p = runner.run({ automation: { id: 'a1', capUsd: 1.5 }, args: [], timeoutMs: 5000 });
    expect(timers[0].ms).toBe(5000);
    timers[0].fn();
    expect(kills).toEqual([[-4242, 'SIGTERM']]);
    expect(timers[1].ms).toBe(3000);
    timers[1].fn();
    expect(kills[1]).toEqual([-4242, 'SIGKILL']);
    calls[0].child.emit('close', null);
    expect(await p).toMatchObject({ status: 'timeout', costUsd: 1.5 });
  });

  it('cancelAll cancels every live run; cancel(id) targets one', async () => {
    const { runner, calls, kills } = setup();
    const p1 = runner.run({ automation: { id: 'a1', capUsd: 1 }, args: [], timeoutMs: 1 });
    const p2 = runner.run({ automation: { id: 'a2', capUsd: 1 }, args: [], timeoutMs: 1 });
    expect(runner.cancel('a1')).toBe(true);
    expect(runner.cancel('nope')).toBe(false);
    calls[0].child.emit('close', null);
    expect(await p1).toMatchObject({ status: 'cancelled', costUsd: 0 });
    runner.cancelAll();
    calls[1].child.emit('close', null);
    expect((await p2).status).toBe('cancelled');
    expect(kills.length).toBe(2);
    expect(runner.running()).toEqual([]);
  });

  it('a spawn that throws is failed', async () => {
    const runner = createRunner({ spawn: () => { throw new Error('ENOENT'); } });
    expect((await runner.run({ automation: a, args: [], timeoutMs: 1 })).status).toBe('failed');
  });
});
