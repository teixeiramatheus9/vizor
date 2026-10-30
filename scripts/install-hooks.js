#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// SubagentStart/Stop: the Maestro's backstage (#142) shows a músico's sub-agents.
const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'SubagentStart', 'SubagentStop'];

// The workspace tracks every file the AI edits, and the voice mode narrates
// commands and sub-agents (#161). These fire on each tool call, so the
// matcher keeps them off Read/Grep/Glob, and async keeps Claude Code from
// waiting even for the hook's spawn.
// PostToolUseFailure: a command that fails (npm test exiting 1) reports there.
export const TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
export const EDIT_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent';
const ALL_EVENTS = [...HOOK_EVENTS, ...TOOL_HOOK_EVENTS];

function isCanonicalToolHook(group, hook, command) {
  return group.matcher === EDIT_TOOL_MATCHER && hook.command === command && hook.async === true;
}

export function addHooks(settings, command) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const eventName of ALL_EVENTS) {
    const isToolEvent = TOOL_HOOK_EVENTS.includes(eventName);
    const groups = [...(next.hooks[eventName] ?? [])];
    const alreadyInstalled = groups.some((group) =>
      (group.hooks ?? []).some((hook) =>
        isToolEvent ? isCanonicalToolHook(group, hook, command) : hook.command === command,
      ),
    );
    if (!alreadyInstalled) {
      groups.push(
        isToolEvent
          ? { matcher: EDIT_TOOL_MATCHER, hooks: [{ type: 'command', command, async: true }] }
          : { hooks: [{ type: 'command', command }] },
      );
    }
    next.hooks[eventName] = groups;
  }
  return next;
}

// shouldRemove(command, group, hook, eventName) — the extra arguments let
// ensureHooks judge the shape of a tool hook, not only its command.
function removeMatching(settings, shouldRemove) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const eventName of ALL_EVENTS) {
    const groups = (next.hooks[eventName] ?? [])
      // A group without a hooks array is someone else's (or malformed): never
      // ours to touch, so it passes through as is (#103).
      .map((group) =>
        Array.isArray(group.hooks)
          ? {
              ...group,
              hooks: group.hooks.filter(
                (hook) => !shouldRemove(hook.command ?? '', group, hook, eventName),
              ),
            }
          : group,
      )
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (groups.length > 0) next.hooks[eventName] = groups;
    else delete next.hooks[eventName];
  }
  return next;
}

export function removeHooks(settings, command) {
  return removeMatching(settings, (candidate) => candidate === command);
}

// Every install of this app registers a command containing the hook script
// name; ensureHooks swaps any stale variant (old path, old runtime, cmd shim)
// for the current command, leaving other tools' hooks untouched.
export const HOOK_MARKER = 'hook-emit';

// Claude Code runs hook commands through a shell: POSIX `VAR=1 cmd` on
// Linux/macOS, but on Windows that syntax does not exist — so the env setup
// lives in a .cmd shim and the settings file only carries the shim path.
export function buildHookCommand({ platform, execPath, hookScript, shimDir }) {
  if (platform === 'win32') {
    const shimPath = path.win32.join(shimDir, 'hook-emit.cmd');
    const content = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" "${hookScript}" %*`,
      '',
    ].join('\r\n');
    return { command: `"${shimPath}"`, shim: { path: shimPath, content } };
  }
  return { command: `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${hookScript}"`, shim: null };
}

// Quitting takes this app's hooks down with it — by marker, so an old install
// path or runtime goes too, and other tools' hooks stay.
export function removeAppHooks(settings) {
  return removeMatching(settings, (candidate) => candidate.includes(HOOK_MARKER));
}

// Our tool hook belongs in exactly one group: copies made by hand (or by an
// old install) would run the hook twice per edit (#103).
function dedupeToolHooks(settings, command) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const eventName of TOOL_HOOK_EVENTS) {
    let seen = false;
    const groups = (next.hooks[eventName] ?? [])
      .map((group) => {
        if (!Array.isArray(group.hooks)) return group;
        const hooks = group.hooks.filter((hook) => {
          if (!isCanonicalToolHook(group, hook, command)) return true;
          if (seen) return false;
          seen = true;
          return true;
        });
        return { ...group, hooks };
      })
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (next.hooks[eventName]) next.hooks[eventName] = groups;
  }
  return next;
}

export function ensureHooks(settings, command) {
  const cleaned = removeMatching(settings, (candidate, group, hook, eventName) => {
    if (!candidate.includes(HOOK_MARKER)) return false;
    if (candidate !== command) return true;
    // Same command, but a tool hook without the matcher or async would run on
    // every tool call, or make Claude Code wait on it.
    return TOOL_HOOK_EVENTS.includes(eventName) && !isCanonicalToolHook(group, hook, command);
  });
  return addHooks(dedupeToolHooks(cleaned, command), command);
}

// The rule guard (src/hook/rule-guard.js) is separate from hook-emit: it
// blocks (no async), may wait minutes for the user, and stays installed after
// the app quits so forbidden rules keep holding.
export const GUARD_MARKER = 'rule-guard';
export const GUARD_TOOL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*';
export const GUARD_TIMEOUT_S = 600;
// UserPromptSubmit hooks are capped at 30 s by Claude Code.
const GUARD_PROMPT_TIMEOUT_S = 25;
const GUARD_EVENTS = ['PreToolUse', 'SessionStart', 'UserPromptSubmit'];

// Only the app's own guard: the copy in <config>/guard/ (.mjs, or the .js of
// the first builds) and the Windows shim in <config>. Another tool whose name
// happens to contain "rule-guard" is not ours to remove (#165).
const GUARD_SCRIPT = /[\\/]guard[\\/]rule-guard\.m?js(?=["'\s]|$)|[\\/]vizor[\\/]rule-guard\.cmd(?=["'\s]|$)/;
export const isGuardCommand = (command) => GUARD_SCRIPT.test(String(command ?? ''));

export function removeGuard(settings) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const eventName of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[eventName])) continue;
    const groups = next.hooks[eventName]
      .map((group) =>
        Array.isArray(group.hooks)
          ? { ...group, hooks: group.hooks.filter((hook) => !isGuardCommand(hook.command)) }
          : group,
      )
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (groups.length > 0) next.hooks[eventName] = groups;
    else delete next.hooks[eventName];
  }
  return next;
}

function guardGroup(eventName, command) {
  if (eventName === 'PreToolUse')
    return { matcher: GUARD_TOOL_MATCHER, hooks: [{ type: 'command', command, timeout: GUARD_TIMEOUT_S }] };
  if (eventName === 'UserPromptSubmit')
    return { hooks: [{ type: 'command', command, timeout: GUARD_PROMPT_TIMEOUT_S }] };
  return { hooks: [{ type: 'command', command }] };
}

// Already right: one canonical guard group per guard event and none elsewhere.
// Where it sits among the other groups does not matter to Claude Code.
function guardInPlace(settings, command) {
  const hooks = settings?.hooks ?? {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const ours = groups.filter((group) => Array.isArray(group.hooks) && group.hooks.some((hook) => isGuardCommand(hook.command)));
    const wanted = GUARD_EVENTS.includes(eventName) ? 1 : 0;
    if (ours.length !== wanted) return false;
    if (wanted && JSON.stringify(ours[0]) !== JSON.stringify(guardGroup(eventName, command))) return false;
  }
  return GUARD_EVENTS.every((eventName) => Array.isArray(hooks[eventName]));
}

export function ensureGuard(settings, command) {
  if (guardInPlace(settings, command)) return settings;
  const next = removeGuard(settings);
  for (const eventName of GUARD_EVENTS) {
    next.hooks[eventName] = [...(next.hooks[eventName] ?? []), guardGroup(eventName, command)];
  }
  return next;
}

// The status-line tap (src/hook/statusline-tap.js) wraps the dev's own
// statusLine: the original command and padding live in a sidecar file in the
// config dir, and settings.json only carries the tap command.
export const STATUSLINE_MARKER = 'statusline-tap';

// The tap script (or its Windows shim) as a path segment: a user's own
// ~/bin/statusline-tap-foo.sh is not ours.
const STATUSLINE_TAP = /(^|[\\/"'\s])statusline-tap\.(js|cmd)(["'\s]|$)/;
export const isStatusLineTap = (command) => STATUSLINE_TAP.test(String(command ?? ''));

export function buildStatusLineCommand({ platform, execPath, tapScript, shimDir }) {
  if (platform === 'win32') {
    const shimPath = path.win32.join(shimDir, 'statusline-tap.cmd');
    const content = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" "${tapScript}" %*`,
      '',
    ].join('\r\n');
    return { command: `"${shimPath}"`, shim: { path: shimPath, content } };
  }
  return { command: `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${tapScript}"`, shim: null };
}

// original: the whole statusLine object the dev had (every key), null when
// there was none, or undefined when already tapped (the sidecar keeps what it has).
export function ensureStatusLine(settings, tapCommand) {
  const current = settings.statusLine;
  if (isStatusLineTap(current?.command)) {
    if (current.command === tapCommand) return { settings, original: undefined };
    return { settings: { ...settings, statusLine: { ...current, command: tapCommand } }, original: undefined };
  }
  const hasOriginal = typeof current?.command === 'string' && current.command.trim() !== '';
  const original = hasOriginal ? { ...current } : null;
  const statusLine = { ...(original ?? {}), type: 'command', command: tapCommand };
  return { settings: { ...settings, statusLine }, original };
}

export function removeStatusLine(settings, original) {
  if (!isStatusLineTap(settings.statusLine?.command)) return settings;
  const { statusLine, ...rest } = settings;
  return original ? { ...rest, statusLine: { ...original } } : rest;
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const hookScript = path.resolve(scriptDir, '..', 'src', 'hook', 'hook-emit.js');
  const command = `node "${hookScript}"`;
  const settingsPath =
    process.env.CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude', 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const backupPath = `${settingsPath}.vizor-${Date.now()}.bak`;
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }

  const remove = process.argv.includes('--remove');
  const next = remove ? removeHooks(settings, command) : addHooks(settings, command);
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${remove ? 'Removed' : 'Installed'} Vizor hooks in ${settingsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
