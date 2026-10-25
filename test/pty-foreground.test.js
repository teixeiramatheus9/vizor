import { describe, it, expect } from 'vitest';
import { inForeground, onTerminal, parseProcStat } from '../src/main/pty-foreground.js';

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
