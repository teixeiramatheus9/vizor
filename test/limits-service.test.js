import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLimitsService, limitNotice, syncStatusLineTap } from '../src/main/limits/limits-service.js';

const T0 = new Date(2026, 9, 29, 10, 0, 0).getTime();
const secs = (ms) => Math.floor(ms / 1000);
const msg = (pct, resetsAt, extra = {}) => ({
  type: 'StatusLine',
  session_id: 's1',
  cwd: '/p',
  cost_usd: 1,
  rate_limits: { five_hour: { used_percentage: pct, resets_at: secs(resetsAt) }, ...extra },
});

function setup(files = {}, settings = { fiveHour: true, sevenDay: true, warnAt: 80, resetNotice: false }, whenReady) {
  const fs = { ...files };
  let clock = T0;
  const h = {
    fs,
    writes: [],
    notify: vi.fn(),
    onChange: vi.fn(),
    log: vi.fn(),
    jump(ms) {
      clock += ms; // the clock moves, the timers do not run (suspend)
    },
    advance(ms) {
      clock += ms;
      vi.setSystemTime(clock);
      vi.advanceTimersByTime(ms);
    },
  };
  h.svc = createLimitsService({
    file: '/cfg/limites.json',
    readFile: async (f) => {
      if (!(f in fs)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return fs[f];
    },
    writeFile: async (f, text) => {
      h.writes.push(text);
      fs[f] = text;
    },
    now: () => clock,
    settings: () => settings,
    notify: h.notify,
    whenReady,
    onChange: h.onChange,
    log: h.log,
  });
  return h;
}

beforeEach(() => vi.useFakeTimers({ now: T0 }));
afterEach(() => vi.useRealTimers());

describe('limits service', () => {
  it('a StatusLine ingest updates the snapshot and calls onChange', () => {
    const h = setup();
    h.svc.ingest(msg(40, T0 + 3600_000));
    const snap = h.svc.snapshot();
    expect(snap.windows.fiveHour.pct).toBe(40);
    expect(snap.stale).toBe(false);
    expect(snap.seenAt).toBe(T0);
    expect(snap.settings.warnAt).toBe(80);
    expect(snap.shares).toEqual({ chats: expect.any(Array), outside: expect.any(Number) });
    expect(h.onChange).toHaveBeenCalled();
  });

  it('a snapshot with nothing read is stale with no seenAt', () => {
    const snap = setup().svc.snapshot();
    expect(snap).toMatchObject({ stale: true, seenAt: null });
  });

  it('goes stale when readings stop', () => {
    const h = setup();
    h.svc.ingest(msg(40, T0 + 5 * 3600_000));
    h.advance(30 * 60_000);
    expect(h.svc.snapshot().stale).toBe(true);
  });

  it('a limit-out arms one timer at resetsAt and limit-back rings exactly once', async () => {
    const h = setup();
    const resetsAt = T0 + 3600_000;
    h.svc.ingest(msg(100, resetsAt));
    await h.svc.flush(); // a notice waits for its own save
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({ kind: 'limit-out', window: 'fiveHour' });
    expect(vi.getTimerCount()).toBe(1);
    h.advance(3600_000);
    await h.svc.flush();
    const kinds = h.notify.mock.calls.map((c) => c[0].kind);
    expect(kinds).toEqual(['limit-out', 'limit-back']);
    h.advance(3600_000);
    h.svc.recheck();
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only one alarm timer is ever pending', () => {
    const h = setup();
    h.svc.ingest(msg(100, T0 + 3600_000));
    h.svc.ingest(msg(100, T0 + 3600_000));
    h.svc.recheck();
    h.svc.ingest(msg(100, T0 + 3600_000, { seven_day: { used_percentage: 100, resets_at: secs(T0 + 86400_000) } }));
    // one for persistence is allowed to be pending too; count alarms by clearing the debounce
    vi.advanceTimersByTime(2000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('boot fires a missed alarm once, and not again on a second boot', async () => {
    const stateAtExit = JSON.stringify({
      windows: { fiveHour: { pct: 100, resetsAt: T0 - 1000, seenAt: T0 - 9000, startedAt: T0 - 9000, startPct: 10, history: [[T0 - 9000, 100]] }, sevenDay: null },
      sessions: {},
      fired: { [`fiveHour:${T0 - 1000}`]: { out: true } },
    });
    const h = setup({ '/cfg/limites.json': stateAtExit });
    await h.svc.boot();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].kind).toBe('limit-back');
    const h2 = setup({ '/cfg/limites.json': h.fs['/cfg/limites.json'] });
    await h2.svc.boot();
    expect(h2.notify).not.toHaveBeenCalled();
  });

  it('a boot notice waits until the UI can hear it', async () => {
    const stateAtExit = JSON.stringify({
      windows: { fiveHour: { pct: 100, resetsAt: T0 - 1000, seenAt: T0 - 9000, startedAt: T0 - 9000, startPct: 10, history: [[T0 - 9000, 100]] }, sevenDay: null },
      sessions: {},
      fired: { [`fiveHour:${T0 - 1000}`]: { out: true } },
    });
    let ready;
    const h = setup({ '/cfg/limites.json': stateAtExit }, undefined, new Promise((resolve) => (ready = resolve)));
    await h.svc.boot();
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.fs['/cfg/limites.json']).toContain('"back":true');
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a firing alarm is on disk before its notice goes out, so a crash never rings it twice', async () => {
    const h = setup();
    h.svc.ingest(msg(100, T0 + 3600_000));
    await Promise.resolve();
    let savedBeforeNotice = null;
    h.notify.mockImplementation((event) => {
      if (event.kind === 'limit-back') savedBeforeNotice = h.writes.length > 0 && /"back":true/.test(h.writes.at(-1));
    });
    h.writes.length = 0;
    h.jump(3600_000 + 1000);
    h.svc.recheck();
    await vi.waitFor(() => expect(savedBeforeNotice).toBe(true));
  });

  it('a window that ends with nothing to ring still leaves the screen on time', async () => {
    const h = setup();
    h.svc.ingest(msg(40, T0 + 3600_000));
    await h.svc.flush();
    h.onChange.mockClear();
    expect(vi.getTimerCount()).toBe(1);
    h.advance(3600_000);
    expect(h.svc.snapshot().windows.fiveHour).toBeNull();
    expect(h.onChange).toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('recheck after a simulated suspend fires a due alarm', async () => {
    const h = setup();
    h.svc.ingest(msg(100, T0 + 3600_000));
    await h.svc.flush();
    h.notify.mockClear();
    // the machine slept: the clock jumped but the timer never ran
    h.jump(7200_000);
    h.svc.recheck();
    await h.svc.flush();
    expect(h.notify.mock.calls.map((c) => c[0].kind)).toEqual(['limit-back']);
  });

  it('debounces writes at 2 s and flushes on demand', async () => {
    const h = setup();
    h.svc.ingest(msg(40, T0 + 3600_000));
    h.svc.ingest(msg(50, T0 + 3600_000));
    expect(h.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.writes).toHaveLength(1);
    h.svc.ingest(msg(60, T0 + 3600_000));
    await h.svc.flush();
    expect(h.writes).toHaveLength(2);
    expect(JSON.parse(h.writes[1]).windows.fiveHour.pct).toBe(60);
    await h.svc.flush();
    expect(h.writes).toHaveLength(2);
  });

  it('a corrupt limites.json starts empty and logs', async () => {
    const h = setup({ '/cfg/limites.json': '{nope' });
    await h.svc.boot();
    expect(h.svc.snapshot().windows).toEqual({ fiveHour: null, sevenDay: null });
    expect(h.log).toHaveBeenCalled();
  });

  it('a missing file starts empty without logging noise', async () => {
    const h = setup();
    await h.svc.boot();
    expect(h.svc.snapshot().seenAt).toBe(null);
  });

  it('a reading that arrives while boot reads the file waits for the saved state', async () => {
    const R = T0 + 3600_000;
    const saved = JSON.stringify({
      windows: { fiveHour: { pct: 85, resetsAt: R, seenAt: T0 - 1000, startedAt: T0 - 9000, startPct: 10, history: [[T0 - 9000, 85]] }, sevenDay: null },
      sessions: {},
      fired: { [`fiveHour:${R}`]: { near: true } },
    });
    const h = setup({ '/cfg/limites.json': saved });
    const booting = h.svc.boot();
    // the socket is up in the same tick: the tap's first reading lands now
    h.svc.ingest(msg(88, R));
    await booting;
    await h.svc.flush();
    await Promise.resolve();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.svc.snapshot().windows.fiveHour.pct).toBe(88);
    expect(h.svc.snapshot().windows.fiveHour.startPct).toBe(10);
  });

  it('ignores malformed messages', () => {
    const h = setup();
    h.svc.ingest(null);
    h.svc.ingest({ type: 'StatusLine' });
    h.svc.ingest({ type: 'StatusLine', rate_limits: 'x' });
    expect(h.svc.snapshot().windows.fiveHour).toBe(null);
  });
});

describe('limitNotice', () => {
  const at = (h, m, d = 29) => new Date(2026, 9, d, h, m).getTime();
  it('warns with the percentage', () => {
    expect(limitNotice({ kind: 'limit-near', window: 'fiveHour', pct: 82, resetsAt: at(14, 30) })).toMatchObject({ text: 'Seu limite de 5h tá em 82%, vai com calma', urgent: true });
  });
  it('says when the 5h limit comes back', () => {
    expect(limitNotice({ kind: 'limit-out', window: 'fiveHour', pct: 100, resetsAt: at(14, 30) }, at(10, 0))).toMatchObject({ text: 'Acabou o limite de 5h — volta às 14:30', urgent: true });
  });
  it('shows the weekday for the weekly reset', () => {
    // 2026-10-29 is a Thursday
    expect(limitNotice({ kind: 'limit-out', window: 'sevenDay', pct: 100, resetsAt: at(9, 0, 29) }, at(1, 0, 25)).text).toBe('Acabou o limite semanal — volta qui 09:00');
  });
  it('rings when it is back', () => {
    expect(limitNotice({ kind: 'limit-back', window: 'fiveHour', pct: 100, resetsAt: 0 })).toMatchObject({ text: 'Voltou! O limite de 5h zerou', urgent: true });
  });
  it('every limit notice skips the chat batch, which would word it as chats waiting', () => {
    expect(limitNotice({ kind: 'limit-reset', window: 'sevenDay', pct: 30, resetsAt: 0 })).toMatchObject({ urgent: true });
  });
});

describe('syncStatusLineTap', () => {
  const TAP = 'ELECTRON_RUN_AS_NODE=1 "/x/vizor" "/cfg/statusline/statusline-tap.js"';
  function tapEnv(settings, sidecar) {
    const env = { settings, sidecar, writes: [], removed: false };
    env.args = {
      tapCommand: TAP,
      readSettings: () => env.settings,
      writeSettings: (next) => {
        env.writes.push(next);
        env.settings = next;
      },
      readOriginal: () => env.sidecar,
      writeOriginal: (value) => {
        env.sidecar = value;
      },
      removeOriginal: () => {
        env.removed = true;
        env.sidecar = undefined;
      },
    };
    return env;
  }
  const dev = { type: 'command', command: 'my-line.sh', padding: 1 };

  it('installs: records the original in the sidecar and writes the tap', () => {
    const env = tapEnv({ statusLine: dev }, undefined);
    const r = syncStatusLineTap({ ...env.args, enabled: true });
    expect(env.sidecar).toEqual(dev);
    expect(env.settings.statusLine.command).toBe(TAP);
    expect(r).toMatchObject({ installed: true, replaced: false });
  });

  it('installs over no statusLine and records null', () => {
    const env = tapEnv({}, undefined);
    syncStatusLineTap({ ...env.args, enabled: true });
    expect(env.sidecar).toBe(null);
  });

  it('never overwrites the sidecar when already tapped', () => {
    const env = tapEnv({ statusLine: { type: 'command', command: TAP } }, dev);
    const r = syncStatusLineTap({ ...env.args, enabled: true });
    expect(env.sidecar).toEqual(dev);
    expect(env.writes).toHaveLength(0);
    expect(r.installed).toBe(true);
  });

  it('reports replaced and leaves a statusLine the dev changed since', () => {
    const changed = { type: 'command', command: 'other.sh' };
    const env = tapEnv({ statusLine: changed }, dev);
    const r = syncStatusLineTap({ ...env.args, enabled: true });
    expect(r).toMatchObject({ installed: false, replaced: true });
    expect(env.settings.statusLine).toEqual(changed);
    expect(env.sidecar).toEqual(dev);
  });

  it('reconnect (force) taps over the changed line and records it as the new original', () => {
    const changed = { type: 'command', command: 'other.sh' };
    const env = tapEnv({ statusLine: changed }, dev);
    const r = syncStatusLineTap({ ...env.args, enabled: true, force: true });
    expect(r).toMatchObject({ installed: true, replaced: false });
    expect(env.settings.statusLine.command).toBe(TAP);
    expect(env.sidecar).toEqual(changed);
  });

  it('re-taps when the current line is the recorded original', () => {
    const env = tapEnv({ statusLine: dev }, dev);
    const r = syncStatusLineTap({ ...env.args, enabled: true });
    expect(r.installed).toBe(true);
    expect(env.settings.statusLine.command).toBe(TAP);
  });

  it('removes: restores the original, then deletes the sidecar', () => {
    const env = tapEnv({ statusLine: { type: 'command', command: TAP } }, dev);
    syncStatusLineTap({ ...env.args, enabled: false });
    expect(env.settings.statusLine).toEqual(dev);
    expect(env.removed).toBe(true);
  });

  it('removes the tap entirely when the dev had no statusLine', () => {
    const env = tapEnv({ statusLine: { type: 'command', command: TAP }, x: 1 }, null);
    syncStatusLineTap({ ...env.args, enabled: false });
    expect(env.settings).toEqual({ x: 1 });
  });

  it('disabled and not tapped leaves settings alone', () => {
    const env = tapEnv({ statusLine: dev }, undefined);
    syncStatusLineTap({ ...env.args, enabled: false });
    expect(env.writes).toHaveLength(0);
  });

  it('disabling after the dev swapped the line keeps the sidecar and reports replaced', () => {
    const changed = { type: 'command', command: 'other.sh' };
    const env = tapEnv({ statusLine: changed }, dev);
    const r = syncStatusLineTap({ ...env.args, enabled: false });
    expect(r).toMatchObject({ installed: false, replaced: true, changed: false });
    expect(env.removed).toBe(false);
    expect(env.sidecar).toEqual(dev);
    expect(env.writes).toHaveLength(0);
    // the next enable asks to reconnect instead of wrapping the new line
    expect(syncStatusLineTap({ ...env.args, enabled: true })).toMatchObject({ installed: false, replaced: true });
    expect(env.settings.statusLine).toEqual(changed);
  });

  it('disabling with the recorded original back in place drops the sidecar', () => {
    const env = tapEnv({ statusLine: dev }, dev);
    expect(syncStatusLineTap({ ...env.args, enabled: false })).toMatchObject({ replaced: false });
    expect(env.removed).toBe(true);
  });

  it('does nothing when settings are unreadable', () => {
    const env = tapEnv(null, undefined);
    expect(syncStatusLineTap({ ...env.args, enabled: true })).toMatchObject({ installed: false });
    expect(env.writes).toHaveLength(0);
  });
});
