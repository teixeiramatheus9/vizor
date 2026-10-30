import { describe, expect, it } from 'vitest';
import { createReviewStore, storeKey } from '../src/main/review/review-store.js';
import { createHash } from 'node:crypto';

function setup(initial, extra = {}) {
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
    mkdir: async (p, o) => { calls.push(['mkdir', p, o]); },
    ...extra,
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
    expect(calls).toEqual([['mkdir', '/d', { recursive: true }], ['write', '/d/k.json.tmp'], ['rename', '/d/k.json.tmp', '/d/k.json']]);
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

  it('serialises overlapping flushes: one tmp at a time, latest state last, no rejection', async () => {
    const releases = [];
    const { store, calls, disk, fire } = setup(undefined, {
      writeFile: async (p, data) => { calls.push(['write', p]); await new Promise((r) => releases.push(r)); disk.set(p, data); },
    });
    await store.load();
    store.approve('a', true);
    const first = store.flush();
    await Promise.resolve(); await Promise.resolve();
    store.approve('b', true); // timer firing mid-flush
    const second = store.flush();
    await fire();
    for (let i = 0; i < 20; i++) { releases.splice(0).forEach((r) => r()); await new Promise((r) => setImmediate(r)); }
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    const renames = calls.filter((c) => c[0] === 'rename');
    expect(renames).toHaveLength(2);
    expect(calls.map((c) => c[0]).join()).toBe('mkdir,write,rename,mkdir,write,rename');
    expect(JSON.parse(disk.get('/d/k.json')).approved).toEqual(['a', 'b']);
  });
  it('creates the directory recursively before writing', async () => {
    const { store, calls } = setup();
    await store.load();
    store.approve('a', true);
    await store.flush();
    expect(calls[0]).toEqual(['mkdir', '/d', { recursive: true }]);
  });
  it('reports a failed debounced write through onError instead of swallowing it', async () => {
    const errors = [];
    const boom = new Error('disk full');
    const { store, fire } = setup(undefined, { writeFile: async () => { throw boom; }, onError: (e) => errors.push(e) });
    await store.load();
    store.approve('a', true);
    await fire();
    await new Promise((r) => setImmediate(r));
    expect(errors).toEqual([boom]);
  });
  it('keeps the change dirty after a failed write so the next flush retries', async () => {
    let fail = true;
    const { store, disk } = setup(undefined, { writeFile: async (p, d) => { if (fail) throw new Error('x'); disk.set(p, d); } });
    await store.load();
    store.approve('a', true);
    await expect(store.flush()).rejects.toThrow('x');
    fail = false;
    await store.flush();
    expect(JSON.parse(disk.get('/d/k.json')).approved).toEqual(['a']);
  });
});
