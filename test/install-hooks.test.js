import { describe, it, expect } from 'vitest';
import {
  HOOK_MARKER,
  addHooks,
  buildHookCommand,
  ensureHooks,
  removeAppHooks,
  removeHooks,
  GUARD_MARKER,
  GUARD_TIMEOUT_S,
  GUARD_TOOL_MATCHER,
  ensureGuard,
  removeGuard,
} from '../scripts/install-hooks.js';

const COMMAND = 'node "/home/user/Claude Manager/src/hook/hook-emit.js"';

describe('install-hooks', () => {
  it('adds one hook group per event', () => {
    const result = addHooks({}, COMMAND);
    for (const eventName of ['UserPromptSubmit', 'Stop', 'Notification']) {
      expect(result.hooks[eventName]).toEqual([
        { hooks: [{ type: 'command', command: COMMAND }] },
      ]);
    }
  });

  it('is idempotent', () => {
    const once = addHooks({}, COMMAND);
    const twice = addHooks(once, COMMAND);
    expect(twice.hooks.Stop).toHaveLength(1);
  });

  it('preserves unrelated settings and existing hooks', () => {
    const settings = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] },
    };
    const result = addHooks(settings, COMMAND);
    expect(result.model).toBe('opus');
    expect(result.hooks.Stop).toHaveLength(2);
    expect(result.hooks.Stop[0].hooks[0].command).toBe('other-tool');
  });

  it('ensureHooks replaces stale hook-emit variants and keeps other tools', () => {
    const stale = 'node "/old/path/src/hook/hook-emit.js"';
    const fresh = 'ELECTRON_RUN_AS_NODE=1 "/opt/Claude Manager/claude-manager" "/opt/app/src/hook/hook-emit.js"';
    const settings = addHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } },
      stale,
    );
    const result = ensureHooks(settings, fresh);
    const stopCommands = result.hooks.Stop.flatMap((group) => group.hooks.map((h) => h.command));
    expect(stopCommands).toContain('other-tool');
    expect(stopCommands).toContain(fresh);
    expect(stopCommands).not.toContain(stale);
  });

  it('ensureHooks is a no-op when the current command is already registered', () => {
    const command = 'node "/app/src/hook/hook-emit.js"';
    const once = ensureHooks({}, command);
    expect(ensureHooks(once, command)).toEqual(once);
  });

  it('removeHooks strips only our command and cleans empty groups', () => {
    const withOurs = addHooks(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } },
      COMMAND,
    );
    const removed = removeHooks(withOurs, COMMAND);
    expect(removed.hooks.Stop).toHaveLength(1);
    expect(removed.hooks.Stop[0].hooks[0].command).toBe('other-tool');
    expect(removed.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('takes every variant of this app\'s hook out when the app quits', () => {
    const settings = addHooks({}, 'node /opt/velho/hook-emit.js');
    const withBoth = addHooks(settings, 'node /opt/novo/hook-emit.js');
    withBoth.hooks.Stop.push({ hooks: [{ type: 'command', command: 'ferramenta-de-terceiro' }] });
    const cleaned = removeAppHooks(withBoth);
    const commands = Object.values(cleaned.hooks ?? {})
      .flat()
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command);
    expect(commands).toEqual(['ferramenta-de-terceiro']);
  });

  // Edits for the workspace, plus Bash/Task/Agent for the voice narration (#161).
  const TOOL_GROUP = {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent',
    hooks: [{ type: 'command', command: COMMAND, async: true }],
  };

  it('adds the edit-tool events with the matcher and async', () => {
    const result = addHooks({}, COMMAND);
    expect(result.hooks.PreToolUse).toEqual([TOOL_GROUP]);
    expect(result.hooks.PostToolUse).toEqual([TOOL_GROUP]);
  });

  it('an install with the old edit-only matcher is swapped for the new one', () => {
    const old = { hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: COMMAND, async: true }] }] } };
    expect(ensureHooks(old, COMMAND).hooks.PreToolUse).toEqual([TOOL_GROUP]);
  });

  it('tool events are idempotent too', () => {
    expect(addHooks(addHooks({}, COMMAND), COMMAND).hooks.PostToolUse).toHaveLength(1);
  });

  it('ensureHooks rewrites our tool hook when its matcher or async drifted', () => {
    const settings = {
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: COMMAND }] }] },
    };
    expect(ensureHooks(settings, COMMAND).hooks.PostToolUse).toEqual([TOOL_GROUP]);
  });

  it("keeps other tools' PreToolUse hooks", () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] };
    const result = ensureHooks({ hooks: { PreToolUse: [other] } }, COMMAND);
    expect(result.hooks.PreToolUse).toEqual([other, TOOL_GROUP]);
  });

  it('removeAppHooks strips the tool events as well', () => {
    const result = removeAppHooks(addHooks({}, COMMAND));
    expect(result.hooks.PreToolUse).toBeUndefined();
    expect(result.hooks.PostToolUse).toBeUndefined();
  });
});

describe('buildHookCommand', () => {
  it('uses the POSIX env prefix off Windows', () => {
    const { command, shim } = buildHookCommand({
      platform: 'linux',
      execPath: '/opt/Claude Manager/claude-manager',
      hookScript: '/opt/Claude Manager/src/hook/hook-emit.js',
      shimDir: '/home/u/.config/claude-manager',
    });
    expect(command).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/opt/Claude Manager/claude-manager" "/opt/Claude Manager/src/hook/hook-emit.js"',
    );
    expect(shim).toBeNull();
  });

  it('writes a cmd shim on win32 because VAR=1 prefixes are POSIX-only', () => {
    const { command, shim } = buildHookCommand({
      platform: 'win32',
      execPath: 'C:\\Program Files\\Claude Manager\\Claude Manager.exe',
      hookScript: 'C:\\Program Files\\Claude Manager\\src\\hook\\hook-emit.js',
      shimDir: 'C:\\Users\\u\\.config\\claude-manager',
    });
    expect(command).toBe('"C:\\Users\\u\\.config\\claude-manager\\hook-emit.cmd"');
    expect(shim.path).toBe('C:\\Users\\u\\.config\\claude-manager\\hook-emit.cmd');
    expect(shim.content).toBe(
      '@echo off\r\n' +
        'set ELECTRON_RUN_AS_NODE=1\r\n' +
        '"C:\\Program Files\\Claude Manager\\Claude Manager.exe" "C:\\Program Files\\Claude Manager\\src\\hook\\hook-emit.js" %*\r\n',
    );
  });

  it('marker matches both the script command and the shim command', () => {
    expect('node "/x/src/hook/hook-emit.js"').toContain(HOOK_MARKER);
    expect('"C:\\Users\\u\\.config\\claude-manager\\hook-emit.cmd"').toContain(HOOK_MARKER);
  });

  it('ensureHooks migrates a stale POSIX command to the shim command', () => {
    const stale = 'ELECTRON_RUN_AS_NODE=1 "/old/app" "/old/src/hook/hook-emit.js"';
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: stale }] }] } };
    const next = ensureHooks(settings, '"C:\\Users\\u\\.config\\claude-manager\\hook-emit.cmd"');
    const commands = next.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toEqual(['"C:\\Users\\u\\.config\\claude-manager\\hook-emit.cmd"']);
  });
});

describe('foreign tool groups (#103)', () => {
  it('leaves a PreToolUse group without a hooks array alone', () => {
    const odd = { matcher: 'Bash' };
    const settings = { hooks: { PreToolUse: [odd] } };
    expect(ensureHooks(settings, COMMAND).hooks.PreToolUse[0]).toEqual(odd);
    expect(removeAppHooks(settings).hooks.PreToolUse).toEqual([odd]);
  });
});

describe('duplicated tool hooks (#103)', () => {
  it('collapses hand-made copies of our tool hook into one', () => {
    const ours = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent', hooks: [{ type: 'command', command: COMMAND, async: true }] };
    const mixed = { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent', hooks: [{ type: 'command', command: 'lint.sh' }, { type: 'command', command: COMMAND, async: true }] };
    const result = ensureHooks({ hooks: { PostToolUse: [ours, { ...ours }, mixed] } }, COMMAND);
    expect(result.hooks.PostToolUse).toEqual([ours, { ...mixed, hooks: [{ type: 'command', command: 'lint.sh' }] }]);
  });
});

describe('rule guard hooks', () => {
  const GUARD = 'ELECTRON_RUN_AS_NODE=1 "/opt/Vizor/vizor" "/home/u/.config/vizor/guard/rule-guard.js"';

  it('ensureGuard registers PreToolUse (blocking, long timeout), SessionStart and UserPromptSubmit', () => {
    const result = ensureGuard({}, GUARD);
    expect(result.hooks.PreToolUse).toEqual([
      { matcher: GUARD_TOOL_MATCHER, hooks: [{ type: 'command', command: GUARD, timeout: GUARD_TIMEOUT_S }] },
    ]);
    expect(result.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: GUARD }] }]);
    expect(result.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: GUARD, timeout: 25 }] }]);
    expect(GUARD_TOOL_MATCHER).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*');
    expect(GUARD_TIMEOUT_S).toBe(600);
  });

  it('ensureGuard is idempotent and replaces an old guard command', () => {
    const once = ensureGuard({}, GUARD);
    expect(ensureGuard(once, GUARD)).toEqual(once);
    const moved = ensureGuard(ensureGuard({}, 'node "/old/rule-guard.js"'), GUARD);
    expect(moved).toEqual(once);
  });

  it('quitting removes hook-emit but leaves the guard', () => {
    const both = ensureGuard(ensureHooks({}, COMMAND), GUARD);
    const result = removeAppHooks(both);
    const all = JSON.stringify(result);
    expect(all).toContain(GUARD_MARKER);
    expect(all).not.toContain(HOOK_MARKER);
  });

  it('removeGuard leaves hook-emit and other tools alone', () => {
    const settings = ensureGuard(
      ensureHooks({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] }] } }, COMMAND),
      GUARD,
    );
    const result = removeGuard(settings);
    const all = JSON.stringify(result);
    expect(all).not.toContain(GUARD_MARKER);
    expect(all).toContain(HOOK_MARKER);
    expect(all).toContain('other-tool');
    expect(result.hooks.SessionStart).toBeUndefined();
  });

  it('ensureHooks never touches the guard', () => {
    const settings = ensureGuard({}, GUARD);
    const result = ensureHooks(settings, COMMAND);
    const commands = Object.values(result.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands.filter((command) => command === GUARD)).toHaveLength(3);
  });
});
