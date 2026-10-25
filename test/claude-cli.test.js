import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { killPendingClaude, runClaude } from '../src/main/claude-cli.js';

function hangingSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', null);
  };
  return { child, spawnFn: () => child };
}

describe('killPendingClaude', () => {
  it('kills a claude -p still running when the app is told to quit', async () => {
    const { child, spawnFn } = hangingSpawn();
    const pending = runClaude({ prompt: 'oi', spawnFn });
    killPendingClaude();
    expect(child.killed).toBe(true);
    expect(await pending).toBeNull();
  });

  it('does nothing when no child is in flight', () => {
    expect(() => killPendingClaude()).not.toThrow();
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const CLI_OK = JSON.stringify({ result: 'oi', usage: { input_tokens: 5, output_tokens: 7 } });

describe('runClaude command fallback', () => {
  it('falls back to the next command on ENOENT', async () => {
    const children = [];
    const spawnFn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const promise = runClaude({ prompt: 'p', spawnFn, commands: ['claude', 'claude.cmd'] });

    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    children[0].emit('error', enoent);
    await Promise.resolve();

    children[1].stdout.emit('data', CLI_OK);
    children[1].emit('close', 0);

    expect(await promise).toEqual({ text: 'oi', tokens: 12 });
    expect(spawnFn.mock.calls.map(([command]) => command)).toEqual(['claude', 'claude.cmd']);
  });

  it('resolves null when every candidate is missing', async () => {
    const children = [];
    const spawnFn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const promise = runClaude({ prompt: 'p', spawnFn, commands: ['a', 'b'] });
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    children[0].emit('error', enoent());
    await Promise.resolve();
    children[1].emit('error', enoent());
    expect(await promise).toBeNull();
  });

  it('does not retry on non-ENOENT errors', async () => {
    const children = [];
    const spawnFn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const promise = runClaude({ prompt: 'p', spawnFn, commands: ['a', 'b'] });
    children[0].emit('error', new Error('EACCES'));
    expect(await promise).toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe('runClaude model', () => {
  it('defaults to haiku and takes another model when asked', () => {
    const seen = [];
    const spawnFn = (_command, args) => {
      seen.push(args[args.indexOf('--model') + 1]);
      const child = hangingSpawn().child;
      return child;
    };
    runClaude({ prompt: 'a', spawnFn });
    runClaude({ prompt: 'b', spawnFn, model: 'sonnet' });
    killPendingClaude();
    expect(seen).toEqual(['haiku', 'sonnet']);
  });
});
