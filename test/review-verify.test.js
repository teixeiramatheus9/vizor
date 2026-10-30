import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { tscPlan, parseTscOutput, testCommand, lintCommand, createVerifier } from '../src/main/review/verify.js';

const root = '/w/proj';
const base = { root, tsconfigText: '{"compilerOptions":{}}', hasLocalTsc: true, config: {}, cacheDir: '/c/tsc' };

describe('tscPlan', () => {
  it('builds the niced command with a per-root tsbuildinfo', () => {
    const sha = createHash('sha1').update(root).digest('hex');
    expect(tscPlan(base)).toEqual({
      command: 'nice',
      args: ['-n', '10', `${root}/node_modules/.bin/tsc`, '--noEmit', '--pretty', 'false', '--incremental', '--tsBuildInfoFile', `/c/tsc/${sha}.tsbuildinfo`],
    });
  });
  it('skips without tsconfig, without local typescript, when disabled and for solution configs', () => {
    expect(tscPlan({ ...base, tsconfigText: null })).toHaveProperty('skip');
    expect(tscPlan({ ...base, hasLocalTsc: false })).toHaveProperty('skip');
    expect(tscPlan({ ...base, config: { tsc: false } })).toHaveProperty('skip');
    const sol = '{ // solution\n "files": [], "references": [{"path":"./a"}] }';
    expect(tscPlan({ ...base, tsconfigText: sol })).toHaveProperty('skip');
  });
  it('does not take a config without files for a solution config', () => {
    expect(tscPlan({ ...base, tsconfigText: '{"references":[{"path":"x"}],"include":["src"]}' })).toHaveProperty('command');
    expect(tscPlan({ ...base, tsconfigText: '{"files":[],"references":[]}' })).toHaveProperty('command');
  });
  it('does not skip a tsconfig with references and files', () => {
    expect(tscPlan({ ...base, tsconfigText: '{"files":["a.ts"],"references":[{"path":"x"}]}' })).toHaveProperty('command');
  });
});

describe('parseTscOutput', () => {
  it('parses errors, relative to root, counting outside ones', () => {
    const out = [
      'src/a.ts(10,5): error TS2322: Type string is not assignable.',
      `${root}/src/b.ts(1,2): error TS1005: ';' expected.`,
      '../other/c.ts(3,4): error TS2304: Cannot find name x.',
    ].join('\n');
    const r = parseTscOutput(out, root);
    expect(r.outside).toBe(1);
    expect(r.errors).toEqual([
      { file: 'src/a.ts', line: 10, col: 5, code: 'TS2322', message: 'Type string is not assignable.' },
      { file: 'src/b.ts', line: 1, col: 2, code: 'TS1005', message: "';' expected." },
    ]);
  });
  it('caps at 500 errors', () => {
    const out = Array.from({ length: 700 }, (_, i) => `a.ts(${i + 1},1): error TS1: m`).join('\n');
    expect(parseTscOutput(out, root).errors).toHaveLength(500);
  });
});

describe('testCommand', () => {
  it('prefers config.test', () => {
    expect(testCommand({ packageText: '{"scripts":{"test":"vitest"}}', config: { test: 'make t' } })).toBe('make t');
  });
  it('uses npm test when there is a script', () => {
    expect(testCommand({ packageText: '{"scripts":{"test":"vitest"}}', config: {} })).toBe('npm test');
  });
  it('ignores the npm init placeholder, missing or broken package', () => {
    const ph = '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}';
    expect(testCommand({ packageText: ph, config: {} })).toBeNull();
    expect(testCommand({ packageText: '{}', config: {} })).toBeNull();
    expect(testCommand({ packageText: 'x', config: {} })).toBeNull();
    expect(testCommand({ packageText: null, config: {} })).toBeNull();
  });
});

describe('lintCommand', () => {
  it('prefers config.lint, else npm run lint when the script exists', () => {
    expect(lintCommand({ packageText: '{"scripts":{"lint":"eslint ."}}', config: { lint: 'make lint' } })).toBe('make lint');
    expect(lintCommand({ packageText: '{"scripts":{"lint":"eslint ."}}' })).toBe('npm run lint');
    expect(lintCommand({ packageText: '{"scripts":{"lint":" "}}' })).toBeNull();
    expect(lintCommand({ packageText: 'x' })).toBeNull();
    expect(lintCommand({ packageText: null })).toBeNull();
  });
});

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('close', null, 'SIGKILL'); };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const plan = { command: 'nice', args: ['x'] };

describe('createVerifier', () => {
  it('ok on exit 0, fail on exit 2 with tsc errors', async () => {
    const { spawn, calls } = fakeSpawn();
    const v = createVerifier({ spawn, now: () => 0 });
    const p = v.run(root, 'tsc', plan);
    expect(calls[0].opts.cwd).toBe(root);
    calls[0].child.emit('close', 0);
    expect(await p).toMatchObject({ kind: 'tsc', status: 'ok' });
    const q = v.run(root, 'tsc', plan);
    calls[1].child.stdout.emit('data', Buffer.from('a.ts(1,2): error TS9: boom\n'));
    calls[1].child.emit('close', 2);
    const r = await q;
    expect(r.status).toBe('fail');
    expect(r.errors).toHaveLength(1);
  });
  it('skipped plans never spawn', async () => {
    const { spawn, calls } = fakeSpawn();
    const r = await createVerifier({ spawn }).run(root, 'tsc', { skip: 'sem tsconfig' });
    expect(r).toMatchObject({ status: 'skipped', reason: 'sem tsconfig' });
    expect(calls).toHaveLength(0);
  });
  it('a second run kills the first, which resolves cancelled', async () => {
    const { spawn, calls } = fakeSpawn();
    const v = createVerifier({ spawn });
    const first = v.run(root, 'tests', plan);
    const second = v.run(root, 'tests', plan);
    expect((await first).status).toBe('cancelled');
    expect(calls[0].child.killed).toBe(true);
    calls[1].child.emit('close', 0);
    expect((await second).status).toBe('ok');
  });
  it('different kinds and roots run side by side; cancelAll cancels the root', async () => {
    const { spawn, calls } = fakeSpawn();
    const v = createVerifier({ spawn });
    const a = v.run(root, 'tsc', plan);
    const b = v.run(root, 'tests', plan);
    expect(calls.every((c) => !c.child.killed)).toBe(true);
    v.cancelAll(root);
    expect((await a).status).toBe('cancelled');
    expect((await b).status).toBe('cancelled');
  });
  it('times out after 120 s with the injected timer', async () => {
    const { spawn, calls } = fakeSpawn();
    const timers = [];
    const v = createVerifier({ spawn, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    const p = v.run(root, 'tests', plan);
    expect(timers[0].ms).toBe(120000);
    timers[0].fn();
    expect((await p).status).toBe('timeout');
    expect(calls[0].child.killed).toBe(true);
  });
  it('keeps only the last 8 KB of output', async () => {
    const { spawn, calls } = fakeSpawn();
    const v = createVerifier({ spawn });
    const p = v.run(root, 'tests', plan);
    calls[0].child.stdout.emit('data', Buffer.from('a'.repeat(20000)));
    calls[0].child.stderr.emit('data', Buffer.from('END'));
    calls[0].child.emit('close', 1);
    const r = await p;
    expect(r.status).toBe('fail');
    expect(r.tail.length).toBe(8192);
    expect(r.tail.endsWith('END')).toBe(true);
  });
  it('parses tsc errors from the whole output, not just the 8 KB tail', async () => {
    const { spawn, calls } = fakeSpawn();
    const p = createVerifier({ spawn }).run(root, 'tsc', plan);
    const c = calls[0].child;
    c.stdout.emit('data', Buffer.from('src/first.ts(1,1): error TS1: early\nsrc/split.ts(2,'));
    c.stdout.emit('data', Buffer.from('3): error TS2: across chunks\n'));
    for (let i = 0; i < 700; i++) c.stdout.emit('data', Buffer.from(`noise ${i} ${'x'.repeat(40)}\n`));
    c.stdout.emit('data', Buffer.from('../out/z.ts(1,1): error TS3: outside'));
    c.emit('close', 2);
    const r = await p;
    expect(r.tail.length).toBe(8192);
    expect(r.errors.map((e) => e.file)).toEqual(['src/first.ts', 'src/split.ts']);
    expect(r.errors[1]).toMatchObject({ line: 2, col: 3 });
    expect(r.outside).toBe(1);
  });
  it('counts errors past the 500 cap without keeping them', async () => {
    const { spawn, calls } = fakeSpawn();
    const p = createVerifier({ spawn }).run(root, 'tsc', plan);
    for (let i = 0; i < 600; i++) calls[0].child.stdout.emit('data', Buffer.from(`a.ts(${i},1): error TS1: m\n`));
    calls[0].child.emit('close', 2);
    const r = await p;
    expect(r.errors).toHaveLength(500);
    expect(r.omitted).toBe(100);
  });
  it('a spawn error is status error, never ok', async () => {
    const { spawn, calls } = fakeSpawn();
    const p = createVerifier({ spawn }).run(root, 'tsc', plan);
    calls[0].child.emit('error', new Error('ENOENT'));
    expect(await p).toMatchObject({ status: 'error', reason: 'ENOENT' });
  });
});
