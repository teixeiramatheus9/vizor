import { describe, it, expect } from 'vitest';
import { createRulesStore, pruneSeenSessions } from '../src/main/rules-store.js';

function memoryFs() {
  const files = {};
  const calls = [];
  return {
    files,
    calls,
    readFile: (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    writeFile: (file, content) => {
      calls.push(['write', file]);
      files[file] = content;
    },
    rename: (from, to) => {
      calls.push(['rename', from, to]);
      files[to] = files[from];
      delete files[from];
    },
  };
}

const draft = (source, kind = 'ask') => ({ id: `id-${source}`, source, kind, irreversible: false, explain: 'x', match: [] });
const MD = '- regra a\n- regra b\n- regra c\n';
const compiled = (fs) => JSON.parse(fs.files['/d/compiladas.json']);

function setup() {
  const fs = memoryFs();
  const store = createRulesStore({ dir: '/d', ...fs });
  store.syncFile('global', MD);
  store.setDrafts('global', ['regra a', 'regra b', 'regra c'].map((source) => draft(source)));
  for (const source of ['regra a', 'regra b', 'regra c']) store.approve('global', `id-${source}`);
  return { fs, store };
}

describe('rules store', () => {
  it('approving a draft puts it in compiladas.json and bumps the version', () => {
    const { fs } = setup();
    expect(compiled(fs).global.map((rule) => rule.source)).toEqual(['regra a', 'regra b', 'regra c']);
    expect(compiled(fs).version).toBe(3);
  });

  it('editing a line drops its approval; the rest stay', () => {
    const { fs, store } = setup();
    const pending = store.syncFile('global', '- regra a\n- regra B nova\n- regra c\n');
    expect(pending).toEqual(['regra B nova']);
    expect(compiled(fs).global.map((rule) => rule.source)).toEqual(['regra a', 'regra c']);
    expect(store.snapshot().global.pending).toEqual(['regra B nova']);
  });

  it('deleting a line removes its rule and bumps the version', () => {
    const { fs, store } = setup();
    const before = compiled(fs).version;
    store.syncFile('global', '- regra a\n- regra c\n');
    expect(compiled(fs).global).toHaveLength(2);
    expect(compiled(fs).version).toBe(before + 1);
  });

  it('discard drops the draft and the line stays pending', () => {
    const fs = memoryFs();
    const store = createRulesStore({ dir: '/d', ...fs });
    store.syncFile('global', '- regra a\n');
    store.setDrafts('global', [draft('regra a')]);
    store.discard('global', 'id-regra a');
    expect(store.snapshot().global.drafts).toEqual([]);
    expect(store.snapshot().global.pending).toEqual(['regra a']);
  });

  it('approve can take an edited translation, keeping id and source', () => {
    const fs = memoryFs();
    const store = createRulesStore({ dir: '/d', ...fs });
    store.syncFile('global', '- regra a\n');
    store.setDrafts('global', [draft('regra a')]);
    store.approve('global', 'id-regra a', { ...draft('outra'), id: 'hack', kind: 'forbid' });
    expect(compiled(fs).global[0]).toMatchObject({ id: 'id-regra a', source: 'regra a', kind: 'forbid' });
  });

  it('a repo whose rules were never compiled contributes nothing', () => {
    const { fs, store } = setup();
    store.markSeenRepo('/repo');
    store.syncFile('/repo', '- regra do repo\n');
    expect(compiled(fs).repos['/repo']).toBeUndefined();
    expect(store.snapshot().repos['/repo']).toMatchObject({ compiled: false, pending: ['regra do repo'] });
  });

  it('keeps the previous compiladas.json and writes through tmp + rename', () => {
    const { fs, store } = setup();
    const previous = fs.files['/d/compiladas.json'];
    fs.calls.length = 0;
    store.syncFile('global', '- regra a\n');
    expect(fs.files['/d/compiladas.anterior.json']).toBe(previous);
    expect(fs.calls).toContainEqual(['rename', '/d/compiladas.json.tmp', '/d/compiladas.json']);
    expect(fs.calls.some(([op, file]) => op === 'write' && file === '/d/compiladas.json')).toBe(false);
  });

  it('survives a restart', () => {
    const { fs } = setup();
    const again = createRulesStore({ dir: '/d', ...fs });
    expect(again.snapshot().global.approved).toHaveLength(3);
    expect(again.snapshot().version).toBe(3);
  });

  it('history keeps the newest 200', () => {
    const { store } = setup();
    for (let n = 0; n < 205; n++) store.addHistory({ at: n, outcome: 'barrado' });
    expect(store.recentHistory(3).map((item) => item.at)).toEqual([204, 203, 202]);
    expect(store.recentHistory(500)).toHaveLength(200);
  });

  it('boots from the previous copy when compiladas.json is corrupt, and never overwrites it with the bad file (I6)', () => {
    const { fs } = setup();
    const good = fs.files['/d/compiladas.json'];
    fs.files['/d/compiladas.anterior.json'] = good;
    fs.files['/d/compiladas.json'] = '{corrupt';
    const again = createRulesStore({ dir: '/d', ...fs });
    expect(again.snapshot().global.approved).toHaveLength(3);
    again.syncFile('global', MD + '- regra d\n');
    again.setDrafts('global', [draft('regra d')]);
    again.approve('global', 'id-regra d');
    expect(compiled(fs).global).toHaveLength(4);
    expect(JSON.parse(fs.files['/d/compiladas.anterior.json']).global).toHaveLength(3);
  });

  it('a repo file that went missing (branch switch) keeps its approvals (I8)', () => {
    const fs = memoryFs();
    const store = createRulesStore({ dir: '/d', ...fs });
    store.markSeenRepo('/repo');
    store.syncFile('/repo', '- regra r\n');
    store.setDrafts('/repo', [draft('regra r')]);
    store.approve('/repo', 'id-regra r');
    store.syncFile('/repo', null);
    expect(compiled(fs).repos['/repo']).toHaveLength(1);
    expect(store.snapshot().repos['/repo'].approved).toHaveLength(1);
  });

  it('a draft that comes back after its line was edited is dropped, not offered for approval (#165)', () => {
    const fs = memoryFs();
    const store = createRulesStore({ dir: '/d', ...fs });
    store.syncFile('global', '- regra velha\n');
    // compiling 'regra velha'… meanwhile the user rewrites the line
    store.syncFile('global', '- regra nova\n');
    store.setDrafts('global', [draft('regra velha')]);
    expect(store.snapshot().global.drafts).toEqual([]);
    expect(store.approve('global', 'id-regra velha')).toBe(false);
    expect(store.snapshot().global.approved).toEqual([]);
  });

  it('a draft for a line already approved does not come back as a draft (#165)', () => {
    const { store } = setup();
    store.setDrafts('global', [draft('regra a', 'forbid')]);
    expect(store.snapshot().global.drafts).toEqual([]);
  });

  it('approve refuses a saved draft whose line is no longer in the file (#165)', () => {
    const fs = memoryFs();
    fs.files['/d/rascunhos.json'] = JSON.stringify({
      scopes: { global: { drafts: [draft('sumiu')], lines: ['outra'], compiled: true } },
    });
    const store = createRulesStore({ dir: '/d', ...fs });
    expect(store.approve('global', 'id-sumiu')).toBe(false);
    expect(fs.files['/d/compiladas.json']).toBeUndefined();
  });

  it('a project file started from the rules screen is the user\'s own, not "de fora" (#165)', () => {
    const fs = memoryFs();
    const store = createRulesStore({ dir: '/d', ...fs });
    store.markOwnedRepo('/novo');
    store.syncFile('/novo', '- regra minha\n');
    expect(store.snapshot().repos['/novo']).toMatchObject({ compiled: true, pending: ['regra minha'] });
    const again = createRulesStore({ dir: '/d', ...fs });
    expect(again.snapshot().repos['/novo'].compiled).toBe(true);
  });
});

describe('seen-version files of old sessions (#165)', () => {
  it('removes the files untouched for longer than the limit, and nothing else', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const files = { old: now - 8 * day, fresh: now - day };
    const removed = [];
    pruneSeenSessions({
      dir: '/d/sessoes',
      now,
      readdir: () => Object.keys(files),
      stat: (file) => ({ mtimeMs: files[file.split('/').pop()], isFile: () => true }),
      unlink: (file) => removed.push(file),
    });
    expect(removed).toEqual(['/d/sessoes/old']);
  });

  it('a missing folder or a file that vanishes midway is fine', () => {
    expect(() =>
      pruneSeenSessions({ dir: '/x', now: 0, readdir: () => { throw new Error('ENOENT'); }, stat: () => null, unlink: () => {} }),
    ).not.toThrow();
    expect(() =>
      pruneSeenSessions({ dir: '/x', now: 0, readdir: () => ['a'], stat: () => { throw new Error('ENOENT'); }, unlink: () => {} }),
    ).not.toThrow();
  });
});
