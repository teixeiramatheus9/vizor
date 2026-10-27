// Runs one automação as `claude -p` in its own process group, so a timeout or
// a cancel takes down everything it spawned. No shell, no flags built here:
// args come from permissions.cliArgs. IO injected.
const STDERR_MAX = 64 * 1024;
const STDOUT_MAX = 4 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
// Same default as the store: a run with no usable cap still counts something.
const DEFAULT_CAP_USD = 1.0;
const capOf = (a) => (Number.isFinite(a?.capUsd) && a.capUsd > 0 ? a.capUsd : DEFAULT_CAP_USD);

// The CLI prints one JSON object; take it from the whole stdout, falling back
// to the last line that parses (a SessionStart hook may print before it).
function parseResult(stdout) {
  const tries = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const text of tries) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') return value;
    } catch { /* try the next */ }
  }
  return null;
}

function fromJson(json) {
  const base = {
    result: typeof json.result === 'string' ? json.result : '',
    costUsd: Number(json.total_cost_usd) || 0,
    durationMs: Number(json.duration_ms) || 0,
    numTurns: Number(json.num_turns) || 0,
    sessionId: json.session_id ?? null,
    permissionDenials: Array.isArray(json.permission_denials) ? json.permission_denials.length : 0,
    raw: json,
  };
  if (json.subtype === 'error_max_budget_usd') return { ...base, status: 'over-cap' };
  return { ...base, status: json.is_error === false ? 'ok' : 'failed' };
}

export function createRunner({ spawn, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, kill = process.kill.bind(process), command = 'claude' }) {
  const live = new Map(); // automation id → { stop(reason), killNow(), done: Promise }

  // onSpawn(pgid): the detached group, for the inflight record a crash leaves behind.
  function run({ automation, args, cwd, env, timeoutMs, onSpawn = () => {} }) {
    // One run per automação at a time: a second one would orphan the first's handle.
    if (live.has(automation.id)) {
      return Promise.resolve({ status: 'failed', result: '', costUsd: 0, durationMs: 0, raw: null, stderr: 'already running' });
    }
    const cap = capOf(automation);
    return new Promise((resolve) => {
      const started = now();
      let stdout = '';
      let stderr = '';
      let reason = null;
      let settled = false;
      let child;
      let markDone;
      const done = new Promise((r) => { markDone = r; });
      try {
        child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch (err) {
        // Unknown cost: count the whole cap rather than nothing.
        resolve({ status: 'failed', result: '', costUsd: cap, durationMs: 0, raw: null, stderr: String(err?.message ?? err) });
        return;
      }
      try {
        onSpawn(child.pid);
      } catch {
        // the record is a best effort; the run goes on
      }
      const killGroup = (signal) => { try { kill(-child.pid, signal); } catch { /* already gone */ } };
      let killTimer = null;
      let fallbackTimer = null;
      const stop = (why) => {
        if (reason || settled) return;
        reason = why;
        killGroup('SIGTERM');
        killTimer = setTimer(() => {
          killGroup('SIGKILL');
          // If even SIGKILL cannot reach it, stop waiting for a 'close' that may never come.
          fallbackTimer = setTimer(() => finish(null), KILL_GRACE_MS);
        }, KILL_GRACE_MS);
      };
      const deadline = setTimer(() => stop('timeout'), timeoutMs);

      child.stdout?.setEncoding?.('utf8');
      child.stderr?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => { if (stdout.length < STDOUT_MAX) stdout += chunk; });
      child.stderr?.on('data', (chunk) => { if (stderr.length < STDERR_MAX) stderr = (stderr + chunk).slice(0, STDERR_MAX); });

      function finish(code, failure = null) {
        if (settled) return;
        settled = true;
        clearTimer(deadline);
        if (killTimer) clearTimer(killTimer);
        if (fallbackTimer) clearTimer(fallbackTimer);
        live.delete(automation.id);
        markDone();
        const wall = now() - started;
        const json = stdout.length < STDOUT_MAX ? parseResult(stdout) : null;
        if (reason === 'timeout') {
          // Killed by the clock: the whole cap counts against the day.
          resolve({ status: 'timeout', result: '', costUsd: cap, durationMs: wall, raw: null, stderr });
        } else if (reason === 'cancel') {
          const cost = Number(json?.total_cost_usd);
          resolve({ status: 'cancelled', result: '', costUsd: Number.isFinite(cost) && cost >= 0 ? cost : cap, durationMs: wall, raw: null, stderr });
        } else if (!json || failure) {
          resolve({ status: 'failed', result: '', costUsd: cap, durationMs: wall, raw: null, stderr: failure ?? stderr });
        } else {
          const out = fromJson(json);
          resolve({ ...out, durationMs: out.durationMs || wall, stderr });
        }
      }
      live.set(automation.id, { stop, killNow: () => killGroup('SIGKILL'), done });
      // 'close' fires after stdio ends, so stdout is complete.
      child.on('close', (code) => finish(code));
      child.on('error', (err) => finish(1, String(err?.message ?? err)));
    });
  }

  return {
    run,
    cancel(id) { const r = live.get(id); if (!r) return false; r.stop('cancel'); return true; },
    // Resolves when every run closed, or after the SIGKILL grace has passed.
    cancelAll() {
      const runs = [...live.values()];
      runs.forEach((r) => r.stop('cancel'));
      return new Promise((resolve) => {
        const timer = setTimer(resolve, KILL_GRACE_MS * 2);
        Promise.all(runs.map((r) => r.done)).then(() => { clearTimer(timer); resolve(); });
      });
    },
    // Synchronous and final: safe from process 'exit', where no timer would fire.
    killAllNow() { for (const r of live.values()) r.killNow(); },
    running() { return [...live.keys()]; },
  };
}
