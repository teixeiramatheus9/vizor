import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Named pipes are the win32 transport; a fresh name per test avoids collisions.
function testSocketPath(dir, name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cm-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(dir, name);
}

const hookScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'hook',
  'hook-emit.js',
);

function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookScript], {
      // blank the wave/term vars so results don't depend on the terminal running the suite
      env: {
        ...process.env,
        WAVETERM_BLOCKID: '',
        WAVETERM_TABID: '',
        WAVETERM_JWT: '',
        ITERM_SESSION_ID: '',
        TERM_SESSION_ID: '',
        KITTY_WINDOW_ID: '',
        KITTY_LISTEN_ON: '',
        WEZTERM_PANE: '',
        WEZTERM_UNIX_SOCKET: '',
        GNOME_TERMINAL_SCREEN: '',
        GNOME_TERMINAL_SERVICE: '',
        TMUX: '',
        TMUX_PANE: '',
        WT_SESSION: '',
        WARP_TERMINAL_SESSION_UUID: '',
        VIZOR_PTY_ID: '',
        ...env,
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', (code) => resolve(code));
    child.stdin.end(input);
  });
}

// Resolves with the first payload a client writes to a fresh socket.
async function listenOnce(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-hook-'));
  const socketFile = testSocketPath(dir, name);
  const received = new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => {
        server.close();
        resolve(JSON.parse(data));
      });
    });
    server.listen(socketFile);
  });
  return { socketFile, received };
}

describe('hook-emit', () => {
  it('forwards the event to the socket and exits 0', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-hook-'));
    const socketFile = testSocketPath(dir, 'test.sock');
    const received = new Promise((resolve) => {
      const server = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk;
        });
        socket.on('end', () => {
          server.close();
          resolve(data);
        });
      });
      server.listen(socketFile);
    });

    const event = { hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/proj' };
    const exitCode = await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile });
    expect(exitCode).toBe(0);
    expect(JSON.parse(await received)).toEqual(event);
  });

  it('attaches the waveterm target when running inside a wave block', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-hook-'));
    const socketFile = testSocketPath(dir, 'test.sock');
    const received = new Promise((resolve) => {
      const server = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk;
        });
        socket.on('end', () => {
          server.close();
          resolve(data);
        });
      });
      server.listen(socketFile);
    });

    const event = { hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/proj' };
    const exitCode = await runHook(JSON.stringify(event), {
      VIZOR_SOCKET: socketFile,
      WAVETERM_BLOCKID: 'b1',
      WAVETERM_TABID: 't1',
      WAVETERM_JWT: 'j1',
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(await received)).toEqual({
      ...event,
      wave: { blockId: 'b1', tabId: 't1', jwt: 'j1' },
    });
  });

  it('attaches the terminal identity vars present in the environment', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-hook-'));
    const socketFile = testSocketPath(dir, 'test.sock');
    const received = new Promise((resolve) => {
      const server = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk;
        });
        socket.on('end', () => {
          server.close();
          resolve(data);
        });
      });
      server.listen(socketFile);
    });

    const event = { hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/proj' };
    const exitCode = await runHook(JSON.stringify(event), {
      VIZOR_SOCKET: socketFile,
      ITERM_SESSION_ID: 'w0t2p0:UUID',
      KITTY_WINDOW_ID: '3',
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-sock',
      GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/80c10d2e_20ab',
      GNOME_TERMINAL_SERVICE: ':1.123',
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(await received)).toEqual({
      ...event,
      term: {
        ITERM_SESSION_ID: 'w0t2p0:UUID',
        KITTY_WINDOW_ID: '3',
        KITTY_LISTEN_ON: 'unix:/tmp/kitty-sock',
        GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/80c10d2e_20ab',
        GNOME_TERMINAL_SERVICE: ':1.123',
      },
    });
  });

  it('captures the warp session uuid, which addresses the tab directly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-hook-warp-'));
    const socketFile = testSocketPath(dir, 'warp.sock');
    const received = new Promise((resolve) => {
      const server = net.createServer((connection) => {
        let data = '';
        connection.on('data', (chunk) => {
          data += chunk;
        });
        connection.on('end', () => {
          server.close();
          resolve(data);
        });
      });
      server.listen(socketFile);
    });

    const event = { hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/proj' };
    const exitCode = await runHook(JSON.stringify(event), {
      VIZOR_SOCKET: socketFile,
      WARP_TERMINAL_SESSION_UUID: '3278322462a249a4b0001d0e24f6907d',
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(await received).term).toEqual({
      WARP_TERMINAL_SESSION_UUID: '3278322462a249a4b0001d0e24f6907d',
    });
  });

  it('exits 0 immediately when VIZOR_INTERNAL=1', async () => {
    const exitCode = await runHook('{"hook_event_name":"Stop"}', {
      VIZOR_INTERNAL: '1',
      VIZOR_SOCKET: '/nonexistent.sock',
    });
    expect(exitCode).toBe(0);
  });

  it('still honours the legacy CLAUDE_MANAGER_INTERNAL=1 — an old build mid-flight must not loop', async () => {
    const exitCode = await runHook('{"hook_event_name":"Stop"}', {
      CLAUDE_MANAGER_INTERNAL: '1',
      VIZOR_SOCKET: '/nonexistent.sock',
    });
    expect(exitCode).toBe(0);
  });

  it('exits 0 when the socket does not exist', async () => {
    // UserPromptSubmit does not trigger the notify-send fallback, keeping tests silent
    const exitCode = await runHook(
      '{"hook_event_name":"UserPromptSubmit","session_id":"x","cwd":"/tmp"}',
      { VIZOR_SOCKET: '/nonexistent/dir/absent.sock' },
    );
    expect(exitCode).toBe(0);
  });

  it('exits 0 on garbage stdin', async () => {
    const exitCode = await runHook('not json at all', {
      VIZOR_SOCKET: '/nonexistent.sock',
    });
    expect(exitCode).toBe(0);
  });

  it('exits 0 on a Stop event when the socket and the notifier are both missing', async () => {
    // Stop triggers fallbackNotify; PATH is emptied so no notifier binary is
    // found anywhere — before the fix this died on an unhandled 'error' event.
    const exitCode = await runHook(
      '{"hook_event_name":"Stop","session_id":"x","cwd":"/tmp/proj"}',
      { VIZOR_SOCKET: '/nonexistent/dir/absent.sock', PATH: '', Path: '' },
    );
    expect(exitCode).toBe(0);
  });
  it('drops tool_response and truncates huge tool_input strings on tool events', async () => {
    const { socketFile, received } = await listenOnce('tool.sock');
    const event = {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      tool_name: 'Write',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: '/tmp/a.js', content: 'x'.repeat(70000) },
      tool_response: { type: 'create', filePath: '/tmp/a.js' },
    };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    const got = await received;
    expect(got.tool_response).toBeUndefined();
    expect(got.tool_response_type).toBe('create');
    expect(got.tool_input).toEqual({ file_path: '/tmp/a.js', content: { truncated: 70000 } });
  });

  it('keeps a short tail of a Bash command\'s output, for the voice narration (#161)', async () => {
    const { socketFile, received } = await listenOnce('bash.sock');
    const event = {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'x'.repeat(5000) + '\n Tests  3 failed | 10 passed', stderr: '', interrupted: false },
    };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    const got = await received;
    expect(got.tool_response).toBeUndefined();
    expect(got.tool_output_tail.length).toBeLessThanOrEqual(300);
    expect(got.tool_output_tail).toContain('3 failed');
  });

  it('a background Bash run forwards its task id, nothing else of the response (#142)', async () => {
    const { socketFile, received } = await listenOnce('bg.sock');
    const event = {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'npm run dev', run_in_background: true },
      tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bfn73e9dt' },
    };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    const got = await received;
    expect(got.background_task_id).toBe('bfn73e9dt');
    expect(got.tool_response).toBeUndefined();
  });

  it('a failed Bash command keeps the tail of its error (PostToolUseFailure, #162)', async () => {
    const { socketFile, received } = await listenOnce('bashfail.sock');
    const event = {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'Exit code 1\n' + 'x'.repeat(2000) + '\n Tests  3 failed | 10 passed',
    };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    const got = await received;
    expect(got.error).toBeUndefined();
    expect(got.tool_output_tail.length).toBeLessThanOrEqual(300);
    expect(got.tool_output_tail).toContain('3 failed');
  });

  it('truncates strings nested in MultiEdit edits', async () => {
    const { socketFile, received } = await listenOnce('multi.sock');
    const event = {
      hook_event_name: 'PreToolUse',
      session_id: 'abc',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/tmp/a.js',
        edits: [{ old_string: 'a', new_string: 'y'.repeat(70000) }],
      },
    };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    expect((await received).tool_input.edits).toEqual([
      { old_string: 'a', new_string: { truncated: 70000 } },
    ]);
  });

  it('leaves non-tool events untouched', async () => {
    const { socketFile, received } = await listenOnce('stop.sock');
    const event = { hook_event_name: 'Stop', session_id: 'abc', message: 'm'.repeat(70000) };
    expect(await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile })).toBe(0);
    expect(await received).toEqual(event);
  });

  it('captures VIZOR_PTY_ID into term', async () => {
    const { socketFile, received } = await listenOnce('pty.sock');
    const event = { hook_event_name: 'Stop', session_id: 'abc' };
    await runHook(JSON.stringify(event), { VIZOR_SOCKET: socketFile, VIZOR_PTY_ID: 'pty-1' });
    expect((await received).term).toEqual({ VIZOR_PTY_ID: 'pty-1' });
  });
  it('exits 0 on JSON that is not an object, even inside a terminal', async () => {
    for (const input of ['null', '"x"', '42', '[]']) {
      const exitCode = await runHook(input, { VIZOR_SOCKET: '/nonexistent.sock', TMUX: 'x' });
      expect(exitCode).toBe(0);
    }
  });
});
