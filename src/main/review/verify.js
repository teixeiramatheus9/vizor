import { createHash } from 'node:crypto';
import path from 'node:path';

// Verification of a worktree: tsc and the project's tests. The first half is
// pure (plans and parsers); createVerifier owns the processes, with spawn and
// timers injected so tests never start anything.

const TIMEOUT_MS = 120_000;
const TAIL_BYTES = 8 * 1024;
const MAX_ERRORS = 500;
const NPM_INIT_PLACEHOLDER = /no test specified/i;

// tsconfig allows comments and trailing commas; strip them before JSON.parse.
function parseTsconfig(text) {
  try {
    const clean = String(text)
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export function tscPlan({ root, tsconfigText, hasLocalTsc, config = {}, cacheDir }) {
  if (config.tsc === false) return { skip: 'tsc desligado na config do projeto' };
  if (tsconfigText == null) return { skip: 'sem tsconfig.json' };
  if (!hasLocalTsc) return { skip: 'sem typescript instalado no projeto' };
  const ts = parseTsconfig(tsconfigText);
  if (ts && Array.isArray(ts.references) && ts.references.length && (!ts.files || ts.files.length === 0)) {
    return { skip: 'tsconfig de solução (só referências)' };
  }
  const info = path.join(cacheDir, `${createHash('sha1').update(root).digest('hex')}.tsbuildinfo`);
  return {
    command: 'nice',
    args: ['-n', '10', path.join(root, 'node_modules', '.bin', 'tsc'), '--noEmit', '--pretty', 'false', '--incremental', '--tsBuildInfoFile', info],
  };
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export function parseTscOutput(text, root) {
  const errors = [];
  let outside = 0;
  for (const line of String(text).split('\n')) {
    const m = TSC_LINE.exec(line.trimEnd());
    if (!m) continue;
    const rel = path.relative(root, path.resolve(root, m[1]));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      outside++;
      continue;
    }
    if (errors.length < MAX_ERRORS) {
      errors.push({ file: rel, line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
    }
  }
  return { errors, outside };
}

export function testCommand({ packageText, config = {} }) {
  if (config.test) return config.test;
  let script;
  try {
    script = JSON.parse(packageText)?.scripts?.test;
  } catch {
    return null;
  }
  if (typeof script !== 'string' || !script.trim() || NPM_INIT_PLACEHOLDER.test(script)) return null;
  return 'npm test';
}

export function createVerifier({ spawn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const active = new Map(); // `${root}\0${kind}` -> { cancel }

  function run(root, kind, plan) {
    if (!plan || plan.skip) {
      return Promise.resolve({ kind, status: 'skipped', reason: plan?.skip ?? 'nada a rodar', ms: 0 });
    }
    const key = `${root}\0${kind}`;
    active.get(key)?.cancel();
    const started = now();

    return new Promise((resolve) => {
      let settled = false;
      let tail = Buffer.alloc(0);
      let timer = null;
      let child;

      // Own process group (detached) so the kill reaches nice -> tsc/npm -> children.
      const kill = () => {
        try {
          if (typeof child?.pid === 'number') process.kill(-child.pid, 'SIGKILL');
          else child?.kill('SIGKILL');
        } catch {
          try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimer(timer);
        if (active.get(key) === handle) active.delete(key);
        resolve({ kind, ...result, ms: now() - started });
      };
      const handle = {
        cancel() {
          finish({ status: 'cancelled' });
          kill();
        },
      };
      active.set(key, handle);

      try {
        child = plan.args
          ? spawn(plan.command, plan.args, { cwd: root, detached: true })
          : spawn(plan.command, { cwd: root, detached: true, shell: true });
      } catch (err) {
        finish({ status: 'error', reason: String(err?.message ?? err) });
        return;
      }

      const onData = (chunk) => {
        tail = Buffer.concat([tail, Buffer.from(chunk)]);
        if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => finish({ status: 'error', reason: String(err?.message ?? err) }));
      child.on('close', (code, signal) => {
        const out = tail.toString('utf8');
        if (code === 0) return finish({ status: 'ok', tail: out });
        if (code == null) return finish({ status: 'error', reason: `encerrado por ${signal ?? 'sinal'}`, tail: out });
        const extra = kind === 'tsc' ? parseTscOutput(out, root) : {};
        finish({ status: 'fail', tail: out, ...extra });
      });
      timer = setTimer(() => {
        finish({ status: 'timeout', tail: tail.toString('utf8') });
        kill();
      }, TIMEOUT_MS);
    });
  }

  function cancelAll(root) {
    for (const [key, h] of [...active]) if (key.startsWith(`${root}\0`)) h.cancel();
  }

  return { run, cancelAll };
}
