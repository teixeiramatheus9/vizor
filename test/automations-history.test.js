import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistory } from '../src/main/automations/history.js';

let dir;
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vzhist-')); });
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe('history', () => {
  it('appends a jsonl line and a markdown report, lists newest first', async () => {
    let minute = 0;
    const h = createHistory({ dir, fs: fsp, now: () => new Date(2026, 9, 27, 10, minute++) });
    await h.append('a1', { name: 'Varredura', status: 'ok', costUsd: 0.2, durationMs: 4000, result: 'tudo certo' });
    await h.append('a1', { name: 'Varredura', status: 'failed', costUsd: 0.1, durationMs: 1000, result: 'quebrou' });
    const list = await h.list('a1', { limit: 5 });
    expect(list.map((e) => e.status)).toEqual(['failed', 'ok']);
    expect(list[1].report).toBe('20261027-1000.md');
    expect(list[0].result).toBeUndefined();
    const md = await h.read('a1', '20261027-1000.md');
    expect(md).toContain('tudo certo');
    expect(md).toContain('Status: ok');
  });
  it('persists only allowlisted fields (no stderr/raw)', async () => {
    const h = createHistory({ dir, fs: fsp });
    const saved = await h.append('a1', { status: 'ok', costUsd: 1, stderr: 'secret', raw: { big: 1 }, result: 'x' });
    expect(saved.stderr).toBeUndefined();
    expect(JSON.stringify(await h.list('a1'))).not.toMatch(/secret|big/);
  });
  it('two runs in the same minute do not overwrite each other', async () => {
    const h = createHistory({ dir, fs: fsp, now: () => new Date(2026, 9, 27, 10, 0) });
    const one = await h.append('a1', { status: 'ok', result: 'um' });
    const two = await h.append('a1', { status: 'ok', result: 'dois' });
    expect(two.report).not.toBe(one.report);
    expect(await h.read('a1', one.report)).toContain('um');
  });
  it('prunes to the newest N runs, removing their reports', async () => {
    let minute = 0;
    const h = createHistory({ dir, fs: fsp, keep: 3, now: () => new Date(2026, 9, 27, 10, minute++) });
    for (let i = 0; i < 5; i++) await h.append('a1', { status: 'ok', result: `r${i}` });
    expect((await h.list('a1', { limit: 99 })).length).toBe(3);
    expect(await h.read('a1', '20261027-1000.md')).toBeNull();
    expect(await h.read('a1', '20261027-1004.md')).toContain('r4');
    expect((await fsp.readdir(path.join(dir, 'a1'))).filter((f) => f.endsWith('.md')).length).toBe(3);
  });
  it('refuses ids and file names that climb out of the folder', async () => {
    const h = createHistory({ dir, fs: fsp });
    await expect(h.append('../x', { status: 'ok' })).rejects.toThrow();
    expect(await h.read('a1', '../../etc/passwd')).toBeNull();
    expect(await h.list('..')).toEqual([]);
  });
});
