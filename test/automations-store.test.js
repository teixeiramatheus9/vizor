import { describe, it, expect, vi } from 'vitest';
import { slugify, validateAutomation, createAutomationStore } from '../src/main/automations/store.js';

const base = { name: 'Resumo do dia', prompt: 'Resuma.', projectRoot: '/work/app', when: 'todo dia às 9h' };
const ok = (raw, opts) => validateAutomation(raw, { now: () => 1000, newId: () => 'id1', ...opts });

describe('slugify', () => {
  it('is ASCII, lowercase, hyphenated and at most 40 chars', () => {
    expect(slugify('Revisão da Ação #1!')).toBe('revisao-da-acao-1');
    expect(slugify('  --Olá,   Mundo--  ')).toBe('ola-mundo');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
    expect(slugify('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
    expect(slugify('€€€')).toBe('automacao');
  });
});

describe('validateAutomation', () => {
  it('fills defaults', () => {
    const r = ok(base);
    expect(r.ok).toBe(true);
    expect(r.automation).toEqual({
      id: 'id1', name: 'Resumo do dia', slug: 'resumo-do-dia', prompt: 'Resuma.', projectRoot: '/work/app',
      when: { kind: 'daily', at: '09:00' }, level: 'read', model: 'sonnet', capUsd: 1, timeoutMin: 15,
      missed: 'run', skillScope: 'personal', paused: false, blockedUntilConfirm: false, createdAt: 1000, lastRun: null,
    });
  });
  it('keeps given values', () => {
    const r = ok({ ...base, id: 'k', slug: 'meu', level: 'worktree', model: 'opus', capUsd: 0.05, timeoutMin: 60, missed: 'skip', skillScope: 'project', paused: true, blockedUntilConfirm: true, createdAt: 5, lastRun: 7 });
    expect(r.automation).toMatchObject({ id: 'k', slug: 'meu', level: 'worktree', model: 'opus', capUsd: 0.05, timeoutMin: 60, missed: 'skip', skillScope: 'project', paused: true, blockedUntilConfirm: true, createdAt: 5, lastRun: 7 });
  });
  it('rejects each bad field', () => {
    for (const bad of [
      { name: '' }, { name: '   ' }, { prompt: '' }, { prompt: 5 }, { projectRoot: '' }, { projectRoot: 'rel/path' },
      { when: 'quando der' }, { when: 'a cada 10 min' }, { level: 'root' }, { model: 'gpt' },
      { capUsd: 0.04 }, { capUsd: 20.01 }, { capUsd: 'x' }, { timeoutMin: 0 }, { timeoutMin: 61 }, { timeoutMin: 1.5 },
      { missed: 'later' }, { skillScope: 'global' }, { slug: 'Bad Slug' }, { lastRun: 'ontem' },
    ]) {
      const r = ok({ ...base, ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.error).toBeTruthy();
    }
    expect(ok(null).ok).toBe(false);
  });
  it('accepts the range edges', () => {
    expect(ok({ ...base, capUsd: 20, timeoutMin: 1 }).ok).toBe(true);
    expect(ok({ ...base, capUsd: 0.05, timeoutMin: 60 }).ok).toBe(true);
  });
});

function fakeFs(initial) {
  const files = new Map(initial ? [['/cfg/automacoes.json', initial]] : []);
  const ops = [];
  return {
    files, ops,
    readFile: async (p) => { if (!files.has(p)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFile: async (p, t) => { ops.push(['write', p]); files.set(p, t); },
    rename: async (a, b) => { ops.push(['rename', a, b]); files.set(b, files.get(a)); files.delete(a); },
    mkdir: async (p) => { ops.push(['mkdir', p]); },
  };
}
const mk = (fs, extra = {}) => createAutomationStore({ file: '/cfg/automacoes.json', ...fs, ...extra });
const A = (over = {}) => ok({ ...base, ...over }).automation;

describe('createAutomationStore', () => {
  it('starts empty when the file is missing, without logging', async () => {
    const log = vi.fn();
    expect(await mk(fakeFs(), { log }).list()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
  it('a corrupt file loads empty and logs', async () => {
    const log = vi.fn();
    expect(await mk(fakeFs('{nope'), { log }).list()).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    const shaped = vi.fn();
    expect(await mk(fakeFs('{"a":1}'), { log: shaped }).list()).toEqual([]);
    expect(shaped).toHaveBeenCalledOnce();
  });
  it('saves atomically (mkdir, tmp, rename) and reads back', async () => {
    const fs = fakeFs();
    const s = mk(fs);
    const a = A();
    expect((await s.save(a)).ok).toBe(true);
    expect(fs.ops).toEqual([['mkdir', '/cfg'], ['write', '/cfg/automacoes.json.tmp'], ['rename', '/cfg/automacoes.json.tmp', '/cfg/automacoes.json']]);
    expect(JSON.parse(fs.files.get('/cfg/automacoes.json'))).toEqual({ automations: [a] });
    expect(await mk(fs).list()).toEqual([a]);
    expect(await s.get('id1')).toEqual(a);
    expect(await s.get('zzz')).toBeNull();
  });
  it('save replaces by id and rejects invalid input without writing', async () => {
    const fs = fakeFs();
    const s = mk(fs);
    await s.save(A());
    await s.save(A({ name: 'Outro' }));
    expect((await s.list()).map((x) => x.name)).toEqual(['Outro']);
    const writes = fs.ops.length;
    const r = await s.save({ ...A(), capUsd: 99 });
    expect(r.ok).toBe(false);
    expect(fs.ops).toHaveLength(writes);
  });
  it('patch merges and revalidates; unknown id fails', async () => {
    const s = mk(fakeFs());
    await s.save(A());
    expect((await s.patch('id1', { paused: true, lastRun: 42 })).automation).toMatchObject({ paused: true, lastRun: 42, name: 'Resumo do dia' });
    expect((await s.patch('id1', { timeoutMin: 999 })).ok).toBe(false);
    expect((await s.get('id1')).timeoutMin).toBe(15);
    expect((await s.patch('nope', { paused: true })).ok).toBe(false);
  });
  it('remove drops the entry', async () => {
    const s = mk(fakeFs());
    await s.save(A());
    expect(await s.remove('id1')).toBe(true);
    expect(await s.remove('id1')).toBe(false);
    expect(await s.list()).toEqual([]);
  });
  it('a failed write reports, keeps memory unchanged, and rejects', async () => {
    const fs = fakeFs();
    const onError = vi.fn();
    fs.rename = async () => { throw new Error('disk full'); };
    const s = mk(fs, { onError });
    await expect(s.save(A())).rejects.toThrow('disk full');
    expect(onError).toHaveBeenCalledOnce();
    expect(await s.list()).toEqual([]);
  });
  it('concurrent saves are serialized and none is lost', async () => {
    const s = mk(fakeFs());
    await Promise.all([s.save(A({ id: 'a', name: 'A' })), s.save(A({ id: 'b', name: 'B' })), s.patch('a', { paused: true })]);
    const list = await s.list();
    expect(list.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(list.find((x) => x.id === 'a').paused).toBe(true);
  });
  it('a second automação with the same name gets a suffixed slug; renames never change a slug', async () => {
    const s = mk(fakeFs());
    const a = (await s.save(A({ id: 'a' }))).automation;
    const b = (await s.save(A({ id: 'b' }))).automation;
    const c = (await s.save(A({ id: 'c' }))).automation;
    expect([a.slug, b.slug, c.slug]).toEqual(['resumo-do-dia', 'resumo-do-dia-2', 'resumo-do-dia-3']);
    const renamed = (await s.patch('b', { name: 'Novo nome' })).automation;
    expect(renamed.slug).toBe('resumo-do-dia-2');
    expect((await s.save({ ...b, name: 'Outro', slug: 'zzz' })).automation.slug).toBe('resumo-do-dia-2');
  });
  it('the suffix still fits in 40 chars', async () => {
    const s = mk(fakeFs());
    const long = 'x'.repeat(50);
    await s.save(A({ id: 'a', name: long }));
    expect((await s.save(A({ id: 'b', name: long }))).automation.slug).toHaveLength(40);
  });
  it('a corrupt file is moved aside before the next save can overwrite it', async () => {
    const fs = fakeFs('{nope');
    const s = mk(fs, { now: () => 99 });
    expect(await s.list()).toEqual([]);
    expect(fs.files.get('/cfg/automacoes.json.corrupt-99')).toBe('{nope');
    expect(fs.files.has('/cfg/automacoes.json')).toBe(false);
  });
  it('dropped invalid entries are backed up once, the rest kept', async () => {
    const good = A();
    const text = JSON.stringify({ automations: [good, { name: '' }] });
    const fs = fakeFs(text);
    const s = mk(fs, { now: () => 7 });
    expect(await s.list()).toEqual([good]);
    await s.save(A({ id: 'z', name: 'Z' }));
    expect(fs.files.get('/cfg/automacoes.json.corrupt-7')).toBe(text);
    expect(fs.ops.filter((o) => o[1] === '/cfg/automacoes.json.corrupt-7')).toHaveLength(1);
  });
  it('projectRoot is normalized and `..` is refused', () => {
    expect(ok({ ...base, projectRoot: '/work//app/' }).automation.projectRoot).toBe('/work/app');
    expect(ok({ ...base, projectRoot: '/work/../etc' }).ok).toBe(false);
  });
  it('list returns copies, not the cached objects', async () => {
    const s = mk(fakeFs());
    await s.save(A());
    (await s.list())[0].name = 'mutated';
    expect((await s.get('id1')).name).toBe('Resumo do dia');
  });
});
