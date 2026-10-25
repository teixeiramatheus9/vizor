import { describe, it, expect } from 'vitest';
import { createRulesStore } from '../src/main/rules-store.js';

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
});
