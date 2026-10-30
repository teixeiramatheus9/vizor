// The POSIX shim settings.json points at: it runs the tap while the app's
// runtime exists, and the dev's own status line by itself once that runtime
// is gone (an AppImage mount after a crash, an uninstalled package).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStatusLineCommand } from '../scripts/install-hooks.js';
import { installTapScript, writeOriginalScript } from '../src/main/limits/limits-service.js';

const tapSource = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook', 'statusline-tap.js');
const PAYLOAD = JSON.stringify({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 40, resets_at: 123 } } });

// A temp HOME with the sidecar pair, the copied tap and the shim, as the app writes them.
function install({ command, runtime = process.execPath, tapPresent = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vzr shim '"));
  const config = path.join(home, '.config', 'vizor');
  const dir = path.join(config, 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  const original = command === undefined ? null : { type: 'command', command };
  if (original) fs.writeFileSync(path.join(config, 'statusline-original.json'), JSON.stringify(original));
  const originalScript = path.join(config, 'statusline-original.sh');
  writeOriginalScript(originalScript, original);
  const tapScript = tapPresent ? installTapScript({ source: tapSource, dir }) : path.join(dir, 'statusline-tap.js');
  const built = buildStatusLineCommand({ platform: 'linux', execPath: runtime, tapScript, shimDir: dir, originalScript });
  fs.writeFileSync(built.shim.path, built.shim.content, { mode: built.shim.mode });
  return { home, command: built.command, shim: built.shim.path };
}

// Runs the statusLine command the way Claude Code does: through sh.
function run(command, input, { home, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      env: { ...process.env, HOME: home, VIZOR_INTERNAL: '', VIZOR_SOCKET: path.join(home, 'none.sock'), VIZOR_TAP_ACTIVE: '', ...env },
    });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input);
  });
}

describe('statusline shim', () => {
  it('runs the original by itself when the runtime is gone: same bytes, same exit code', async () => {
    const original = `printf 'a"b\\n' && cat && echo "$X" >&2; exit 3`;
    const ctx = install({ command: original, runtime: '/tmp/.mount_gone/vizor' });
    const shimmed = await run(ctx.command, PAYLOAD, { home: ctx.home, env: { X: 'x y' } });
    const direct = await run(original, PAYLOAD, { home: ctx.home, env: { X: 'x y' } });
    expect(shimmed.stdout.equals(direct.stdout)).toBe(true);
    expect(shimmed.stdout.toString()).toBe(`a"b\n${PAYLOAD}`);
    expect(shimmed.stderr).toBe('x y\n');
    expect(shimmed.code).toBe(3);
  });

  it('runs the original when the tap script is gone too', async () => {
    const ctx = install({ command: 'echo mine', tapPresent: false });
    const result = await run(ctx.command, PAYLOAD, ctx);
    expect(result.stdout.toString()).toBe('mine\n');
    expect(result.code).toBe(0);
  });

  it('prints nothing and exits 0 with no original and no runtime', async () => {
    const ctx = install({ runtime: '/nope/vizor' });
    const result = await run(ctx.command, PAYLOAD, ctx);
    expect(result.stdout.length).toBe(0);
    expect(result.code).toBe(0);
  });

  it('goes through the tap while the runtime exists', async () => {
    const ctx = install({ command: 'cat; exit 4' });
    const sock = path.join(ctx.home, 'vizor.sock');
    const received = [];
    const server = net.createServer((s) => s.on('data', (c) => received.push(c.toString())));
    await new Promise((resolve) => server.listen(sock, resolve));
    try {
      const result = await run(ctx.command, PAYLOAD, { home: ctx.home, env: { VIZOR_SOCKET: sock } });
      expect(result.stdout.toString()).toBe(PAYLOAD);
      expect(result.code).toBe(4);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(JSON.parse(received.join('').trim())).toMatchObject({ type: 'StatusLine', session_id: 's1' });
    } finally {
      server.close();
    }
  });

  it('never loops: inside a tap it prints nothing, and an original pointing back at the shim stops', async () => {
    const inside = install({ command: 'echo mine' });
    const nested = await run(inside.command, PAYLOAD, { home: inside.home, env: { VIZOR_TAP_ACTIVE: '1' } });
    expect(nested.stdout.length).toBe(0);
    expect(nested.code).toBe(0);
    // A hand-edited .sh that calls the shim again, with the runtime gone.
    const ctx = install({ command: 'echo x', runtime: '/nope/vizor' });
    fs.writeFileSync(path.join(ctx.home, '.config', 'vizor', 'statusline-original.sh'), `${ctx.command}; echo after`);
    const looped = await run(ctx.command, PAYLOAD, ctx);
    expect(looped.stdout.toString()).toBe('after\n');
    expect(looped.code).toBe(0);
  });

  it('writeOriginalScript mirrors the sidecar and never stores a tap command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vzr-orig-'));
    const file = path.join(dir, 'statusline-original.sh');
    writeOriginalScript(file, { type: 'command', command: 'my-line "$X"' });
    expect(fs.readFileSync(file, 'utf8')).toBe('my-line "$X"');
    writeOriginalScript(file, { command: "'/h/.config/vizor/statusline/statusline-tap.sh'" });
    expect(fs.existsSync(file)).toBe(false);
    writeOriginalScript(file, { command: 'x' });
    writeOriginalScript(file, null);
    expect(fs.existsSync(file)).toBe(false);
  });
});
