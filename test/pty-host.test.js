import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PTY_BATCH_MS, PTY_BUFFER_CHARS, PTY_FLOW_HIGH, PTY_FLOW_LOW, createPtyHost, ptyEnv, withoutClaudeSession } from '../src/main/pty-host.js';

function fakeSpawn() {
  const spawned = [];
  const spawn = (file, args, options) => {
    const child = {
      file,
      args,
      options,
      writes: [],
      resizes: [],
      killed: false,
      dataListeners: [],
      exitListeners: [],
      onData(callback) {
        this.dataListeners.push(callback);
      },
      onExit(callback) {
        this.exitListeners.push(callback);
      },
      write(data) {
        this.writes.push(data);
      },
      resize(cols, rows) {
        this.resizes.push([cols, rows]);
      },
      kill() {
        this.killed = true;
      },
      paused: false,
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      emitData(data) {
        for (const listener of this.dataListeners) listener(data);
      },
      emitExit(exitCode) {
        for (const listener of this.exitListeners) listener({ exitCode });
      },
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

function makeHost() {
  const { spawn, spawned } = fakeSpawn();
  let n = 0;
  const host = createPtyHost({ spawn, shell: '/bin/zsh', newId: () => `p${++n}` });
  return { host, spawned };
}

describe('ptyEnv', () => {
  it('tags the terminal and strips what must never leak into it', () => {
    const base = {
      PATH: '/bin',
      VIZOR_INTERNAL: '1',
      CLAUDE_MANAGER_INTERNAL: '1',
      ELECTRON_RUN_AS_NODE: '1',
    };
    const env = ptyEnv(base, 'p9');
    expect(env).toEqual({ PATH: '/bin', VIZOR_PTY_ID: 'p9', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(base.VIZOR_INTERNAL).toBe('1');
  });

  it('does not carry the identity of the Claude Code session that launched the Vizor (#151)', () => {
    const fromClaude = {
      HOME: '/home/u',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: '173cc3bc',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_EXECPATH: '/usr/bin/claude',
      CLAUDE_CODE_SSE_PORT: '1234',
      CLAUDE_PID: '7727',
      CLAUDE_EFFORT: 'high',
      // the user's own settings stay
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'opus',
    };
    expect(ptyEnv(fromClaude, 'p2')).toEqual({
      HOME: '/home/u',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'opus',
      VIZOR_PTY_ID: 'p2',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
  });

  it('withoutClaudeSession strips the same session identity from an env in place', () => {
    const env = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_VERTEX: '1' };
    withoutClaudeSession(env);
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_USE_VERTEX: '1' });
  });

  it('does not carry the identity of the terminal that launched the Vizor', () => {
    const launcher = {
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%3',
      KITTY_WINDOW_ID: '2',
      KITTY_LISTEN_ON: 'unix:/tmp/k',
      WEZTERM_PANE: '1',
      WEZTERM_UNIX_SOCKET: '/tmp/w',
      WARP_TERMINAL_SESSION_UUID: 'abc',
      GNOME_TERMINAL_SCREEN: '/org/gnome/x',
      GNOME_TERMINAL_SERVICE: ':1.2',
      ITERM_SESSION_ID: 'w0',
      TERM_SESSION_ID: 'w1',
      WT_SESSION: 'w2',
      TERM_PROGRAM: 'kitty',
      TERM_PROGRAM_VERSION: '1',
      VTE_VERSION: '7600',
      WINDOWID: '123',
      HOME: '/home/u',
    };
    expect(ptyEnv(launcher, 'p1')).toEqual({
      HOME: '/home/u',
      VIZOR_PTY_ID: 'p1',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
  });
});

describe('createPtyHost', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens a login shell in the folder, with the tagged env', () => {
    const { host, spawned } = makeHost();
    const terminal = host.open({ cwd: '/r', cols: 100, rows: 30 });
    expect(terminal).toMatchObject({ id: 'p1', cwd: '/r', alive: true, exitCode: null });
    expect(spawned[0].file).toBe('/bin/zsh');
    expect(spawned[0].args).toEqual(['-l']);
    expect(spawned[0].options).toMatchObject({ name: 'xterm-256color', cols: 100, rows: 30, cwd: '/r' });
    expect(spawned[0].options.env.VIZOR_PTY_ID).toBe('p1');
  });

  it('types claude once the shell first speaks', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r', command: 'claude' });
    expect(spawned[0].writes).toEqual([]);
    spawned[0].emitData('$ ');
    spawned[0].emitData('more');
    expect(spawned[0].writes).toEqual(['claude\r']);
    vi.advanceTimersByTime(2000);
    expect(spawned[0].writes).toEqual(['claude\r']);
  });

  it('types any start command it is given, such as a resume', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r', command: 'claude --resume 4b706711-9840-4931-8b0f-d6d51518d6ba' });
    spawned[0].emitData('$ ');
    expect(spawned[0].writes).toEqual(['claude --resume 4b706711-9840-4931-8b0f-d6d51518d6ba\r']);
  });

  it('types nothing into a plain terminal', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0].emitData('$ ');
    vi.advanceTimersByTime(2000);
    expect(spawned[0].writes).toEqual([]);
  });

  it('types claude anyway after 1.5 s of silence', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r', command: 'claude' });
    vi.advanceTimersByTime(1499);
    expect(spawned[0].writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(spawned[0].writes).toEqual(['claude\r']);
  });

  it('coalesces output into one event per batch window', () => {
    const { host, spawned } = makeHost();
    const events = [];
    host.on('data', (event) => events.push(event));
    host.open({ cwd: '/r' });
    spawned[0].emitData('a');
    spawned[0].emitData('b');
    expect(events).toEqual([]);
    vi.advanceTimersByTime(PTY_BATCH_MS);
    expect(events).toEqual([{ id: 'p1', data: 'ab' }]);
  });

  it('hands pending output to the replay, never to both replay and live', () => {
    const { host, spawned } = makeHost();
    const events = [];
    host.on('data', ({ data }) => events.push(data));
    host.open({ cwd: '/r' });
    spawned[0].emitData('chunk1');
    // the live event goes out before the replay is read, where a view that is
    // not ready yet drops it — the replay then carries it exactly once
    expect(host.buffer('p1')).toBe('chunk1');
    expect(events).toEqual(['chunk1']);
    vi.advanceTimersByTime(PTY_BATCH_MS * 2);
    expect(events).toEqual(['chunk1']);
  });

  it('keeps only the newest output in the scrollback buffer', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0].emitData('x'.repeat(PTY_BUFFER_CHARS));
    spawned[0].emitData('0123456789');
    const buffer = host.buffer('p1');
    expect(buffer).toHaveLength(PTY_BUFFER_CHARS);
    expect(buffer.endsWith('0123456789')).toBe(true);
  });

  it('on exit keeps the tab, its buffer and flushes pending output first', () => {
    const { host, spawned } = makeHost();
    const order = [];
    host.on('data', ({ data }) => order.push(`data:${data}`));
    host.on('exit', ({ exitCode }) => order.push(`exit:${exitCode}`));
    host.open({ cwd: '/r' });
    spawned[0].emitData('bye');
    spawned[0].emitExit(0);
    expect(order).toEqual(['data:bye', 'exit:0']);
    expect(host.list()).toEqual([expect.objectContaining({ id: 'p1', alive: false, exitCode: 0 })]);
    expect(host.buffer('p1')).toBe('bye');
    expect(host.aliveCount()).toBe(0);
  });

  it('routes write and resize to the right terminal and ignores unknown ids', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/a' });
    host.open({ cwd: '/b' });
    host.write('p2', 'ls\r');
    host.resize('p2', 120, 40);
    host.write('nope', 'x');
    host.resize('nope', 1, 1);
    host.close('nope');
    expect(spawned[0].writes).toEqual([]);
    expect(spawned[1].writes).toEqual(['ls\r']);
    expect(spawned[1].resizes).toEqual([[120, 40]]);
    expect(host.buffer('nope')).toBe('');
  });

  it('close kills a live terminal and forgets it', () => {
    const { host, spawned } = makeHost();
    const changes = [];
    host.on('change', () => changes.push(host.list().length));
    host.open({ cwd: '/r' });
    host.close('p1');
    expect(spawned[0].killed).toBe(true);
    expect(host.list()).toEqual([]);
    expect(changes).toEqual([1, 0]);
  });

  it('killAll kills every live terminal', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/a' });
    host.open({ cwd: '/b' });
    spawned[1].emitExit(1);
    host.killAll();
    expect(spawned.map((child) => child.killed)).toEqual([true, false]);
    expect(host.aliveCount()).toBe(0);
  });

  it('a full buffer restarts at a line boundary, not mid escape sequence (#112)', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0].emitData(`\u001b[31m${'x'.repeat(PTY_BUFFER_CHARS)}\nlinha inteira\n`);
    const buffer = host.buffer('p1');
    expect(buffer.startsWith('linha inteira')).toBe(true);
  });

  it('an ended terminal keeps only its tail (#116)', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0].emitData(`${'a'.repeat(200000)}\nfim\n`);
    spawned[0].emitExit(0);
    expect(host.buffer('p1').length).toBeLessThanOrEqual(65536);
    expect(host.buffer('p1').endsWith('fim\n')).toBe(true);
  });

  it('remembers each terminal title so a reloaded window gets it back (#117)', () => {
    const { host } = makeHost();
    host.open({ cwd: '/r' });
    host.setTitle('p1', 'meu chat');
    host.setTitle('nope', 'x');
    expect(host.list()[0].title).toBe('meu chat');
  });

  it('gives the terminal device of a live pty (#95)', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0]._pty = '/dev/pts/7';
    expect(host.ttyPath('p1')).toBe('/dev/pts/7');
    spawned[0].emitExit(0);
    expect(host.ttyPath('p1')).toBeNull();
    expect(host.ttyPath('nope')).toBeNull();
  });

  it('pauses a terminal the window cannot keep up with, and resumes once it catches up (#113)', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    spawned[0].emitData('x'.repeat(PTY_FLOW_HIGH + 10));
    vi.advanceTimersByTime(PTY_BATCH_MS);
    expect(spawned[0].paused).toBe(true);
    host.ack('p1', PTY_FLOW_HIGH + 10 - PTY_FLOW_LOW + 1);
    expect(spawned[0].paused).toBe(false);
  });

  it('ignores acks for unknown terminals and never goes below zero', () => {
    const { host, spawned } = makeHost();
    host.open({ cwd: '/r' });
    host.ack('nope', 5);
    host.ack('p1', 999);
    spawned[0].emitData('y'.repeat(10));
    vi.advanceTimersByTime(PTY_BATCH_MS);
    expect(spawned[0].paused).toBe(false);
  });
});
