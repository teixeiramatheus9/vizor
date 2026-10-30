import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPipePath, startSocketServer, stopSocketServer } from '../src/main/socket-server.js';

// Named pipes are the win32 transport; a fresh name per test avoids collisions.
function testSocketPath(dir, name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cm-test-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(dir, name);
}

function sendLines(socketFile, payload) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketFile, () => client.end(payload));
    client.on('close', resolve);
    client.on('error', reject);
  });
}

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('socket server', () => {
  it('parses one JSON event per line', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = testSocketPath(dir, 'srv.sock');
    const onEvent = vi.fn();
    const server = startSocketServer(socketFile, onEvent, () => {});
    await new Promise((resolve) => server.on('listening', resolve));

    await sendLines(socketFile, '{"a":1}\n{"b":2}\n');
    await waitTick();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ a: 1 }, expect.any(Function));
    expect(onEvent).toHaveBeenCalledWith({ b: 2 }, expect.any(Function));
    server.close();
  });

  it('skips malformed lines and keeps going', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = testSocketPath(dir, 'srv.sock');
    const onEvent = vi.fn();
    const logFn = vi.fn();
    const server = startSocketServer(socketFile, onEvent, logFn);
    await new Promise((resolve) => server.on('listening', resolve));

    await sendLines(socketFile, 'garbage\n{"ok":true}\n');
    await waitTick();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ ok: true }, expect.any(Function));
    expect(logFn).toHaveBeenCalled();
    server.close();
  });

  it('replaces a stale socket file on startup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = testSocketPath(dir, 'srv.sock');
    const first = startSocketServer(socketFile, () => {}, () => {});
    await new Promise((resolve) => first.on('listening', resolve));
    await new Promise((resolve) => first.close(resolve));

    const second = startSocketServer(socketFile, () => {}, () => {});
    await new Promise((resolve, reject) => {
      second.on('listening', resolve);
      second.on('error', reject);
    });
    second.close();
  });

  // Unix-socket-only semantics: pipes never touch the filesystem.
  it.skipIf(process.platform === 'win32')('takes the socket file down with it on quit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = path.join(dir, 'quit.sock');
    const server = startSocketServer(socketFile, () => {}, () => {});
    await new Promise((resolve) => server.on('listening', resolve));
    expect(fs.existsSync(socketFile)).toBe(true);
    stopSocketServer(server, socketFile);
    expect(fs.existsSync(socketFile)).toBe(false);
  });

  it('never touches the filesystem for a pipe endpoint', () => {
    const unlink = vi.spyOn(fs, 'unlinkSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    stopSocketServer(null, '\\\\.\\pipe\\claude-manager-u');
    expect(unlink).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    unlink.mockRestore();
    mkdir.mockRestore();
  });
});

describe('isPipePath', () => {
  it('recognizes win32 named pipes', () => {
    expect(isPipePath('\\\\.\\pipe\\claude-manager-u')).toBe(true);
  });
  it('rejects filesystem paths', () => {
    expect(isPipePath('/home/u/.config/claude-manager/manager.sock')).toBe(false);
    expect(isPipePath('C:\\Users\\u\\.config\\manager.sock')).toBe(false);
  });
});

describe('socket server replies', () => {
  it('a client that waits gets the reply line; a one-way client still works', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = testSocketPath(dir, 'srv.sock');
    const seen = [];
    const server = startSocketServer(
      socketFile,
      (event, reply) => {
        seen.push(event);
        if (event.type === 'guard-ask') reply({ answer: 'liberar' });
      },
      () => {},
    );
    await new Promise((resolve) => server.on('listening', resolve));
    const answer = await new Promise((resolve, reject) => {
      const client = net.connect(socketFile, () => client.write('{"type":"guard-ask"}\n'));
      let data = '';
      client.on('data', (chunk) => (data += chunk));
      client.on('close', () => resolve(data));
      client.on('error', reject);
    });
    expect(JSON.parse(answer)).toEqual({ answer: 'liberar' });
    await sendLines(socketFile, '{"hook_event_name":"Stop"}\n');
    await waitTick();
    expect(seen).toHaveLength(2);
    server.close();
  });

  it('tells the handler when the asking client goes away', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-server-'));
    const socketFile = testSocketPath(dir, 'srv.sock');
    let closed = false;
    const server = startSocketServer(socketFile, (_event, reply) => reply.onClose(() => (closed = true)), () => {});
    await new Promise((resolve) => server.on('listening', resolve));
    await new Promise((resolve) => {
      const client = net.connect(socketFile, () => {
        client.write('{"type":"guard-ask"}\n');
        setTimeout(() => client.destroy(), 30);
      });
      client.on('close', resolve);
    });
    await waitTick();
    expect(closed).toBe(true);
    server.close();
  });
});
