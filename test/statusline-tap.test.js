import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tapScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'hook',
  'statusline-tap.js',
);

async function makeHome(original) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'vzr-tap-'));
  const configDir = path.join(home, '.config', 'vizor');
  await mkdir(configDir, { recursive: true });
  if (original) await writeFile(path.join(configDir, 'statusline-original.json'), JSON.stringify(original));
  return { home, configDir };
}

function runTap(input, { home, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tapScript], {
      env: { ...process.env, HOME: home, USERPROFILE: home, VIZOR_INTERNAL: '', VIZOR_SOCKET: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const PAYLOAD = JSON.stringify({
  session_id: 's1',
  cwd: '/tmp/proj',
  cost: { total_cost_usd: 1.25 },
  rate_limits: { five_hour: { used_percentage: 40, resets_at: 123 }, seven_day: { used_percentage: 5, resets_at: 456 } },
});

describe('statusline-tap', () => {
  it('prints the original output byte-identical, with env and quotes intact', async () => {
    const ctx = await makeHome({ command: `printf 'a"b' && echo "$X"` });
    const result = await runTap(PAYLOAD, { ...ctx, env: { X: 'x y' } });
    expect(result.stdout).toBe('a"bx y\n');
    expect(result.code).toBe(0);
  });

  it('gives the original the exact stdin bytes', async () => {
    const ctx = await makeHome({ command: 'cat' });
    const result = await runTap(PAYLOAD, ctx);
    expect(result.stdout).toBe(PAYLOAD);
  });

  it('forwards the exit code and stderr', async () => {
    const ctx = await makeHome({ command: 'echo oops >&2; exit 3' });
    const result = await runTap(PAYLOAD, ctx);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('oops\n');
  });

  it('sends the trimmed message to the socket before the original finishes', async () => {
    const ctx = await makeHome({ command: 'sleep 0.6; echo done' });
    const socketPath = path.join(ctx.home, 's.sock');
    const received = [];
    let firstAt = 0;
    const server = net.createServer((conn) => {
      let data = '';
      conn.on('data', (c) => {
        data += c;
        if (!firstAt) firstAt = Date.now();
      });
      conn.on('end', () => received.push(data));
    });
    await new Promise((r) => server.listen(socketPath, r));
    const started = Date.now();
    const result = await runTap(PAYLOAD, { ...ctx, env: { VIZOR_SOCKET: socketPath } });
    const finished = Date.now();
    server.close();
    expect(result.stdout).toBe('done\n');
    expect(firstAt).toBeGreaterThan(0);
    expect(firstAt).toBeLessThan(finished - 400);
    expect(started).toBeLessThan(firstAt);
    const lines = received.join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: 'StatusLine',
      session_id: 's1',
      cwd: '/tmp/proj',
      cost_usd: 1.25,
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 123 },
        seven_day: { used_percentage: 5, resets_at: 456 },
      },
    });
  });

  it('falls back to workspace.current_dir', async () => {
    const ctx = await makeHome({ command: 'true' });
    const socketPath = path.join(ctx.home, 's.sock');
    let data = '';
    const server = net.createServer((conn) => conn.on('data', (c) => (data += c)));
    await new Promise((r) => server.listen(socketPath, r));
    await runTap(JSON.stringify({ session_id: 's2', workspace: { current_dir: '/w' } }), {
      ...ctx,
      env: { VIZOR_SOCKET: socketPath },
    });
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    expect(JSON.parse(data.trim()).cwd).toBe('/w');
  });

  it('still prints with no socket', async () => {
    const ctx = await makeHome({ command: 'echo hi' });
    const result = await runTap(PAYLOAD, { ...ctx, env: { VIZOR_SOCKET: path.join(ctx.home, 'none.sock') } });
    expect(result.stdout).toBe('hi\n');
  });

  it('still prints, fast, when the socket never reads', async () => {
    const ctx = await makeHome({ command: 'echo hi' });
    const socketPath = path.join(ctx.home, 's.sock');
    const server = net.createServer((conn) => conn.pause());
    await new Promise((r) => server.listen(socketPath, r));
    const started = Date.now();
    const result = await runTap(PAYLOAD, { ...ctx, env: { VIZOR_SOCKET: socketPath } });
    server.close();
    expect(result.stdout).toBe('hi\n');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('passes 2 MB of garbage stdin through untouched', async () => {
    const ctx = await makeHome({ command: 'wc -c' });
    const result = await runTap('x'.repeat(2 * 1024 * 1024), ctx);
    expect(result.stdout.trim()).toBe(String(2 * 1024 * 1024));
  });

  it('sends nothing under VIZOR_INTERNAL=1 but still runs the original', async () => {
    const ctx = await makeHome({ command: 'echo hi' });
    const socketPath = path.join(ctx.home, 's.sock');
    let connections = 0;
    const server = net.createServer((conn) => {
      connections += 1;
      conn.resume();
    });
    await new Promise((r) => server.listen(socketPath, r));
    const result = await runTap(PAYLOAD, { ...ctx, env: { VIZOR_SOCKET: socketPath, VIZOR_INTERNAL: '1' } });
    server.close();
    expect(result.stdout).toBe('hi\n');
    expect(connections).toBe(0);
  });

  it('prints nothing and exits 0 with no original', async () => {
    const ctx = await makeHome(null);
    const result = await runTap(PAYLOAD, ctx);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('prints nothing with a corrupted sidecar', async () => {
    const ctx = await makeHome(null);
    await writeFile(path.join(ctx.configDir, 'statusline-original.json'), '{nope');
    const result = await runTap(PAYLOAD, ctx);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('does not loop when the sidecar points at the tap', async () => {
    const ctx = await makeHome({ command: `node "${tapScript}"` });
    const started = Date.now();
    const result = await runTap(PAYLOAD, ctx);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('prints nothing and sends nothing when already inside a tap', async () => {
    const ctx = await makeHome({ command: 'echo hi' });
    const result = await runTap(PAYLOAD, { ...ctx, env: { VIZOR_TAP_ACTIVE: '1' } });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('keeps the tap runtime switches out of the original env', async () => {
    const ctx = await makeHome({ command: 'echo "[${ELECTRON_RUN_AS_NODE-unset}]"' });
    const result = await runTap(PAYLOAD, { ...ctx, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(result.stdout).toBe('[unset]\n');
  });

  it('adds almost nothing when the socket never reads', async () => {
    const ctx = await makeHome({ command: 'true' });
    const socketPath = path.join(ctx.home, 's.sock');
    const server = net.createServer((conn) => conn.pause());
    await new Promise((r) => server.listen(socketPath, r));
    const time = async (env) => {
      const t = Date.now();
      await runTap(PAYLOAD, { ...ctx, env });
      return Date.now() - t;
    };
    await time({});
    const base = Math.min(await time({}), await time({}));
    const withSocket = Math.min(...[await time({ VIZOR_SOCKET: socketPath }), await time({ VIZOR_SOCKET: socketPath })]);
    server.close();
    expect(withSocket - base).toBeLessThan(80);
  });

  it.skipIf(process.platform === 'win32')('kills the whole original on SIGTERM', async () => {
    const ctx = await makeHome({ command: 'sleep 30 & echo $! > "$PIDFILE"; wait' });
    const pidFile = path.join(ctx.home, 'pid');
    const child = spawn(process.execPath, [tapScript], {
      env: { ...process.env, HOME: ctx.home, USERPROFILE: ctx.home, VIZOR_INTERNAL: '', VIZOR_SOCKET: '', PIDFILE: pidFile },
    });
    child.stdin.end(PAYLOAD);
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const { readFile } = await import('node:fs/promises');
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '')) || 0;
    }
    expect(pid).toBeGreaterThan(0);
    child.kill('SIGTERM');
    expect(await closed).toBe(143);
    await new Promise((r) => setTimeout(r, 200));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
