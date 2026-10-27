// Runs one automação as `claude -p` in its own process group, so a timeout or
// a cancel takes down everything it spawned. No shell, no flags built here:
// args come from permissions.cliArgs. IO injected.
const STDERR_MAX = 64 * 1024;
const KILL_GRACE_MS = 3000;

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
  const live = new Map(); // automation id → { stop(reason) }

  function run({ automation, args, cwd, env, timeoutMs }) {
    return new Promise((resolve) => {
      const started = now();
      let stdout = '';
      let stderr = '';
      let reason = null;
      let settled = false;
      let child;
      try {
        child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch (err) {
        resolve({ status: 'failed', result: '', costUsd: 0, durationMs: 0, raw: null, stderr: String(err?.message ?? err) });
        return;
      }
      const killGroup = (signal) => { try { kill(-child.pid, signal); } catch { /* already gone */ } };
      let killTimer = null;
      const stop = (why) => {
        if (reason || settled) return;
        reason = why;
        killGroup('SIGTERM');
        killTimer = setTimer(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const deadline = setTimer(() => stop('timeout'), timeoutMs);
      live.set(automation.id, { stop });

      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { if (stderr.length < STDERR_MAX) stderr = (stderr + chunk).slice(0, STDERR_MAX); });

      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimer(deadline);
        if (killTimer) clearTimer(killTimer);
        live.delete(automation.id);
        const wall = now() - started;
        if (reason === 'timeout') {
          // Killed by the clock: the whole cap counts against the day.
          resolve({ status: 'timeout', result: '', costUsd: automation.capUsd, durationMs: wall, raw: null, stderr });
          return;
        }
        if (reason === 'cancel') {
          resolve({ status: 'cancelled', result: '', costUsd: 0, durationMs: wall, raw: null, stderr });
          return;
        }
        const json = parseResult(stdout);
        if (!json) {
          resolve({ status: 'failed', result: '', costUsd: 0, durationMs: wall, raw: null, stderr });
          return;
        }
        const out = fromJson(json);
        resolve({ ...out, durationMs: out.durationMs || wall, stderr });
      };
      // 'close' fires after stdio ends, so stdout is complete.
      child.on('close', (code) => finish(code));
      child.on('error', () => finish(1));
    });
  }

  return {
    run,
    cancel(id) { const r = live.get(id); if (!r) return false; r.stop('cancel'); return true; },
    cancelAll() { for (const r of [...live.values()]) r.stop('cancel'); },
    running() { return [...live.keys()]; },
  };
}
