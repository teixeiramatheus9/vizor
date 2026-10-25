import { spawn } from 'node:child_process';

// Parses `claude -p --output-format json` output: the model's text lives in
// `.result` and real token usage in `.usage`.
export function parseCliJson(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const usage = parsed.usage ?? {};
    const tokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    return { text: typeof parsed.result === 'string' ? parsed.result : '', tokens };
  } catch {
    return null;
  }
}

// Runs one headless prompt (Haiku unless told otherwise) with the
// anti-recursion guard set.
// Resolves {text, tokens} or null (spawn failure, timeout, non-zero exit,
// unparseable output) — never rejects.
// Quitting used to orphan a claude -p mid-flight: it is only killed on the
// timeout, so it kept running (and spending tokens) after the app was gone.
const pending = new Set();

export function killPendingClaude() {
  for (const child of pending) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
  pending.clear();
}

// npm installs `claude` as claude.cmd on Windows, which spawn() without a
// shell cannot execute — so win32 tries the .cmd variant after ENOENT.
// shell:true is not an option: the prompt is arbitrary text.
function defaultCommands() {
  return process.platform === 'win32' ? ['claude', 'claude.cmd'] : ['claude'];
}

// The gerente only writes text: no MCP servers, no user settings (their
// hooks and plugins), no tools, no skills. Measured live: 6.7-8 s and ~32k
// context tokens per call became ~4 s and ~3k (#161, the voice felt slow).
// --bare would be faster still, but it never reads the OAuth login.
const LEAN = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--tools', '', '--disable-slash-commands'];

export function runClaude({
  prompt,
  model = 'haiku',
  timeoutMs = 15000,
  spawnFn = spawn,
  commands = defaultCommands(),
}) {
  return new Promise((resolve) => {
    const tryCommand = (index) => {
      let settled = false;
      let child;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (child) pending.delete(child);
        resolve(value);
      };

      try {
        child = spawnFn(
          commands[index],
          ['-p', prompt, '--model', model, '--output-format', 'json', ...LEAN],
          {
            env: { ...process.env, VIZOR_INTERNAL: '1', CLAUDE_MANAGER_INTERNAL: '1' },
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
      } catch {
        if (index + 1 < commands.length) tryCommand(index + 1);
        else finish(null);
        return;
      }

      pending.add(child);
      let stdout = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
        finish(null);
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        if (error?.code === 'ENOENT' && index + 1 < commands.length) {
          settled = true; // dead attempt must not resolve later via 'close'
          pending.delete(child);
          tryCommand(index + 1);
          return;
        }
        finish(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? parseCliJson(stdout) : null);
      });
    };
    tryCommand(0);
  });
}
