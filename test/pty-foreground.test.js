import { describe, it, expect } from 'vitest';
import { createPtyIdentityCheck, inForeground, onTerminal, parseProcStat } from '../src/main/pty-foreground.js';

// /proc/<pid>/stat: "pid (comm) state ppid pgrp session tty_nr tpgid ..."
const stat = ({ comm = 'claude', state = 'S', pgrp = 100, tty = 34820, tpgid = 100 } = {}) =>
  `100 (${comm}) ${state} 1 ${pgrp} 100 ${tty} ${tpgid} 4194304 0 0 0 0`;

describe('parseProcStat', () => {
  it('reads state, process group, tty and the tty foreground group', () => {
    expect(parseProcStat(stat())).toEqual({ state: 'S', pgrp: 100, ttyNr: 34820, tpgid: 100 });
  });

  it('survives a command name with spaces and parentheses', () => {
    expect(parseProcStat(stat({ comm: 'a (b) c' })).pgrp).toBe(100);
  });

  it('is null for garbage', () => {
    expect(parseProcStat('')).toBeNull();
  });
});

describe('inForeground', () => {
  it('is true for the foreground job of this exact terminal', () => {
    expect(inForeground({ stat: stat(), ttyRdev: 34820 })).toBe(true);
  });

  it('is false when another job is in front (vim, sh, a pipeline)', () => {
    expect(inForeground({ stat: stat({ tpgid: 222 }), ttyRdev: 34820 })).toBe(false);
  });

  it('is false for a stopped claude (Ctrl+Z)', () => {
    expect(inForeground({ stat: stat({ state: 'T' }), ttyRdev: 34820 })).toBe(false);
  });

  it('is false when claude is on another terminal', () => {
    expect(inForeground({ stat: stat({ tty: 34821 }), ttyRdev: 34820 })).toBe(false);
  });

  it('is false without a stat', () => {
    expect(inForeground({ stat: null, ttyRdev: 34820 })).toBe(false);
  });
});

describe('onTerminal (#140)', () => {
  it('is true when the process runs on that terminal, in front or not', () => {
    expect(onTerminal({ stat: stat({ tpgid: 999 }), ttyRdev: 34820 })).toBe(true);
  });

  it('is false for a process on another terminal (a terminal app started from the tab)', () => {
    expect(onTerminal({ stat: stat({ tty: 1234 }), ttyRdev: 34820 })).toBe(false);
  });

  it('is null when it cannot tell', () => {
    expect(onTerminal({ stat: null, ttyRdev: 34820 })).toBeNull();
  });
});

describe('createPtyIdentityCheck (#148)', () => {
  const RDEV = 34820;
  const setup = ({ pid = 100 } = {}) => {
    const calls = { pid: 0, stat: 0 };
    const state = { time: 0, pid, tty: RDEV, alive: new Set([pid]) };
    const check = createPtyIdentityCheck({
      ttyPath: (ptyId) => (ptyId === 'p1' ? '/dev/pts/9' : null),
      ttyRdev: () => RDEV,
      readSessionPid: () => {
        calls.pid += 1;
        return state.pid;
      },
      readStat: (p) => {
        calls.stat += 1;
        return stat({ tty: p === state.pid ? state.tty : 1 });
      },
      pidAlive: (p) => state.alive.has(p),
      now: () => state.time,
      ttlMs: 3000,
    });
    return { check, calls, state };
  };

  it('holds when the session runs on that tab, and drops a tab that is gone', () => {
    const { check } = setup();
    expect(check('s1', 'p1')).toBe(true);
    expect(check('s1', 'gone')).toBe(false);
  });

  it('does not read the session registry and /proc again within the ttl', () => {
    const { check, calls, state } = setup();
    check('s1', 'p1');
    state.time = 1000;
    check('s1', 'p1');
    check('s1', 'p1');
    expect(calls).toEqual({ pid: 1, stat: 1 });
    state.time = 4000;
    check('s1', 'p1');
    expect(calls).toEqual({ pid: 2, stat: 2 });
  });

  it('a session running on another terminal is dropped, from the cache too', () => {
    const { check, calls, state } = setup();
    state.tty = 1;
    expect(check('s1', 'p1')).toBe(false);
    expect(check('s1', 'p1')).toBe(false);
    expect(calls.pid).toBe(1);
  });

  it('looks again at once when the cached pid is gone (the session moved to another process)', () => {
    const { check, calls, state } = setup();
    expect(check('s1', 'p1')).toBe(true);
    state.alive = new Set([200]);
    state.pid = 200;
    state.tty = 1;
    state.time = 500;
    expect(check('s1', 'p1')).toBe(false);
    expect(calls.pid).toBe(2);
  });

  it('a session not registered yet is not cached', () => {
    const { check, calls, state } = setup({ pid: null });
    expect(check('s1', 'p1')).toBe(true); // can't tell: keep what the hook saw
    state.pid = 300;
    state.alive = new Set([300]);
    state.tty = 1;
    state.time = 100;
    expect(check('s1', 'p1')).toBe(false);
    expect(calls.pid).toBe(2);
  });

  it('can not read /proc: keeps what the hook saw', () => {
    const check = createPtyIdentityCheck({
      ttyPath: () => '/dev/pts/9',
      ttyRdev: () => {
        throw new Error('EACCES');
      },
      readSessionPid: () => 100,
      readStat: () => stat(),
      pidAlive: () => true,
    });
    expect(check('s1', 'p1')).toBe(true);
  });
});
