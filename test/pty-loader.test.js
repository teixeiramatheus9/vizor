import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { loadPty } from '../src/main/pty-loader.js';

describe('loadPty', () => {
  it('refuses off Linux without touching the native module', () => {
    expect(loadPty({ platform: 'darwin' })).toEqual({ pty: null, error: 'só no Linux' });
  });

  it.runIf(process.platform === 'linux')('spawns a real pty with the env it was given', async () => {
    const { pty, error } = loadPty();
    expect(error).toBeNull();
    const child = pty.spawn('/bin/sh', ['-c', 'printf "$VIZOR_PTY_ID"'], {
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { ...process.env, VIZOR_PTY_ID: 'p1' },
    });
    let output = '';
    child.onData((data) => (output += data));
    const exitCode = await new Promise((resolve) => child.onExit(({ exitCode: code }) => resolve(code)));
    expect(output).toContain('p1');
    expect(exitCode).toBe(0);
  });
});
