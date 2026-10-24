import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POLL_MS } from '../src/main/command-changes.js';
import { createCommandWatcher } from '../src/main/command-watcher.js';

// A fake repo: `status` is what git status prints, `sigs` what stat returns.
function fakeRepo() {
  const repo = { status: '', sigs: {}, statusCalls: 0, broken: false };
  const gitStatus = async () => {
    repo.statusCalls += 1;
    return repo.broken ? null : repo.status;
  };
  const statFile = async (abs) => repo.sigs[abs] ?? 'gone';
  return { repo, gitStatus, statFile };
}

async function tick() {
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

describe('command watcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup({ explained = () => false } = {}) {
    const { repo, gitStatus, statFile } = fakeRepo();
    const changes = [];
    const logs = [];
    const watcher = createCommandWatcher({
      gitStatus,
      statFile,
      explained,
      onChange: (change) => changes.push(change),
      log: (line) => logs.push(line),
    });
    return { repo, watcher, changes, logs };
  }

  it('records a baseline first, then reports a change left unexplained for a cycle', async () => {
    const { repo, watcher, changes } = setup();
    repo.status = ' M pre.txt\0';
    repo.sigs['/r/pre.txt'] = '1:1';
    watcher.setActive('/r', ['s1']);
    await tick(); // baseline
    repo.status = ' M pre.txt\0 M b.txt\0';
    repo.sigs['/r/b.txt'] = '2:2';
    await tick(); // candidate
    expect(changes).toEqual([]);
    await tick(); // still unexplained
    expect(changes).toEqual([{ root: '/r', filePath: '/r/b.txt', owners: ['s1'] }]);
    await tick();
    expect(changes).toHaveLength(1);
  });

  it('never reports a change an edit hook explains', async () => {
    const { repo, watcher, changes } = setup({ explained: (owners, abs) => abs === '/r/a.js' });
    watcher.setActive('/r', ['s1']);
    await tick();
    repo.status = ' M a.js\0';
    repo.sigs['/r/a.js'] = '3:3';
    await tick();
    await tick();
    await tick();
    expect(changes).toEqual([]);
  });

  it('stops polling when no session runs a task there', async () => {
    const { repo, watcher } = setup();
    watcher.setActive('/r', ['s1']);
    await tick();
    watcher.setActive('/r', []);
    const calls = repo.statusCalls;
    await tick();
    await tick();
    expect(repo.statusCalls).toBe(calls);
    expect(watcher.activeRoots()).toEqual([]);
  });

  it('gives up on a folder git cannot read', async () => {
    const { repo, watcher, logs } = setup();
    repo.broken = true;
    watcher.setActive('/r', ['s1']);
    await tick();
    expect(watcher.activeRoots()).toEqual([]);
    expect(logs.some((line) => line.includes('/r'))).toBe(true);
  });

  it('skips a mass change instead of replaying it later', async () => {
    const { repo, watcher, changes, logs } = setup();
    watcher.setActive('/r', ['s1']);
    await tick();
    repo.status = Array.from({ length: 201 }, (_, n) => ` M f${n}\0`).join('');
    for (let n = 0; n < 201; n++) repo.sigs[`/r/f${n}`] = '9:9';
    await tick();
    await tick();
    await tick();
    expect(changes).toEqual([]);
    expect(logs.some((line) => line.includes('201'))).toBe(true);
  });

  it('hands every change to all sessions running a task there', async () => {
    const { repo, watcher, changes } = setup();
    watcher.setActive('/r', ['s1']);
    await tick();
    watcher.setActive('/r', ['s1', 's2']);
    repo.status = ' M c.txt\0';
    repo.sigs['/r/c.txt'] = '4:4';
    await tick();
    await tick();
    expect(changes).toEqual([{ root: '/r', filePath: '/r/c.txt', owners: ['s1', 's2'] }]);
  });
});
