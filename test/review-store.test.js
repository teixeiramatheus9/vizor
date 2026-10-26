import { describe, expect, it } from 'vitest';
import { createReviewStore, storeKey } from '../src/main/review/review-store.js';
import { createHash } from 'node:crypto';

function setup(initial) {
  const calls = [];
  const disk = new Map(initial ? [['/d/k.json', initial]] : []);
  const timers = [];
  const store = createReviewStore({
    dir: '/d', key: 'k',
    readFile: async (p) => { if (!disk.has(p)) throw new Error('ENOENT'); return disk.get(p); },
    writeFile: async (p, data) => { calls.push(['write', p]); disk.set(p, data); },
    rename: async (from, to) => { calls.push(['rename', from, to]); disk.set(to, disk.get(from)); disk.delete(from); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { timers[id - 1] = null; },
  });
  const fire = async () => { for (const fn of timers.splice(0)) await fn?.(); await Promise.resolve(); };
  return { store, calls, disk, fire };
}

describe('review store', () => {
  it('keys by sha1 of the worktree path', () => {
    expect(storeKey('/w')).toBe(createHash('sha1').update('/w').digest('hex'));
  });
  it('coalesces five approvals into one write via tmp + rename', async () => {
    const { store, calls, disk, fire } = setup();
    await store.load();
    for (const id of ['a', 'b', 'c', 'd', 'e']) store.approve(id, true);
    expect(calls).toEqual([]);
    await fire();
    expect(calls).toEqual([['write', '/d/k.json.tmp'], ['rename', '/d/k.json.tmp', '/d/k.json']]);
    expect(JSON.parse(disk.get('/d/k.json')).approved).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('flush writes immediately and cancels the pending timer', async () => {
    const { store, calls, fire } = setup();
    await store.load();
    store.approve('a', true);
    await store.flush();
    await fire();
    expect(calls.filter((c) => c[0] === 'write')).toHaveLength(1);
  });
  it('round-trips approvals and prefs, and prunes vanished hunks', async () => {
    const first = setup();
    await first.store.load();
    first.store.approve('a', true);
    first.store.approve('b', true);
    first.store.setPrefs({ tab: 'impact', drawerOpen: true });
    first.store.prune(['b']);
    await first.store.flush();
    const second = setup(first.disk.get('/d/k.json'));
    const loaded = await second.store.load();
    expect([...loaded.approved]).toEqual(['b']);
    expect(loaded.prefs).toMatchObject({ tab: 'impact', drawerOpen: true, openFiles: [] });
  });
  it('un-approves', async () => {
    const { store } = setup();
    await store.load();
    store.approve('a', true);
    store.approve('a', false);
    await store.flush();
    expect([...(await store.load()).approved]).toEqual([]);
  });
  it('loads empty from a corrupt or missing file without throwing', async () => {
    for (const initial of ['{not json', undefined]) {
      const loaded = await setup(initial).store.load();
      expect(loaded.approved.size).toBe(0);
      expect(loaded.prefs.openFiles).toEqual([]);
    }
  });
});
