// The Vizor's side of the usage limits: ingests status-line readings, keeps the
// window state on disk, owns the ONE alarm timer, turns the model's events into
// pt-BR notices and installs/removes the status-line tap. Every effect is
// injected, so it runs under fake timers and an in-memory fs.
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, reduce, due, nextAlarm, shares } from './limits-model.js';
import { ensureStatusLine, removeStatusLine, isStatusLineTap } from '../../../scripts/install-hooks.js';

export const LIMITS_FILE_NAME = 'limites.json';
export const TAP_SCRIPT_NAME = 'statusline-tap.js';
const SAVE_DEBOUNCE_MS = 2000;
// A status line only refreshes while some chat is active: past this, the
// numbers are a memory, not a reading.
export const STALE_AFTER_MS = 15 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const NAMES = { fiveHour: 'de 5h', sevenDay: 'semanal' };
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = (n) => String(n).padStart(2, '0');

// "às 14:30" when it is today, "qui 09:00" otherwise.
function whenBack(resetsAt, now) {
  const date = new Date(resetsAt);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? `às ${clock}` : `${WEEKDAYS[date.getDay()]} ${clock}`;
}

// A model event becomes { text, speech, urgent } in the gerente's voice.
// Out and back are urgent: they change what the user can do right now.
export function limitNotice(event, now = Date.now()) {
  const name = NAMES[event.window] ?? event.window;
  let text;
  let urgent = false;
  if (event.kind === 'limit-near') text = `Seu limite ${name} tá em ${Math.round(event.pct)}%, vai com calma`;
  else if (event.kind === 'limit-out') {
    text = `Acabou o limite ${name} — volta ${whenBack(event.resetsAt, now)}`;
    urgent = true;
  } else if (event.kind === 'limit-back') {
    text = `Voltou! O limite ${name} zerou`;
    urgent = true;
  } else text = `O limite ${name} virou, tá zerado de novo`;
  return { text, speech: `${text}.`, urgent };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validState(value) {
  return isObject(value) && isObject(value.windows) && isObject(value.sessions) && isObject(value.fired);
}

export function createLimitsService({
  file,
  readFile,
  writeFile,
  now = Date.now,
  setTimeout: setTimer = (...args) => setTimeout(...args),
  clearTimeout: clearTimer = (...args) => clearTimeout(...args),
  notify = () => {},
  settings = {},
  onChange = () => {},
  log = () => {},
} = {}) {
  let state = emptyState();
  let alarm = null;
  let saveTimer = null;
  let dirty = false;
  let writing = Promise.resolve();

  const cfg = () => (typeof settings === 'function' ? settings() : settings) ?? {};

  function emit(events) {
    for (const event of events) {
      try {
        notify({ ...event, ...limitNotice(event, now()) });
      } catch (error) {
        log(`limits notify failed: ${error}`);
      }
    }
  }

  function arm() {
    if (alarm !== null) clearTimer(alarm);
    alarm = null;
    const at = nextAlarm(state, cfg());
    if (at === null) return;
    alarm = setTimer(() => {
      alarm = null;
      recheck();
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - now())));
  }

  function write() {
    dirty = false;
    const text = `${JSON.stringify(state)}\n`;
    writing = writing.then(() => writeFile(file, text)).catch((error) => log(`limits save failed: ${error}`));
    return writing;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) return;
    saveTimer = setTimer(() => {
      saveTimer = null;
      if (dirty) write();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flush() {
    if (saveTimer !== null) clearTimer(saveTimer);
    saveTimer = null;
    if (dirty) await write();
    else await writing;
  }

  function ingest(message) {
    if (!isObject(message) || !isObject(message.rate_limits)) return;
    const reading = {
      sessionId: typeof message.session_id === 'string' ? message.session_id : undefined,
      cwd: typeof message.cwd === 'string' ? message.cwd : undefined,
      costUsd: typeof message.cost_usd === 'number' ? message.cost_usd : undefined,
      rateLimits: message.rate_limits,
    };
    const result = reduce(state, reading, now(), cfg());
    state = result.state;
    scheduleSave();
    arm();
    emit(result.events);
    onChange();
  }

  // Fires what came due (an alarm, a wake from suspend, a boot after a long stop).
  function recheck() {
    const result = due(state, now(), cfg());
    const changed = result.events.length > 0 || JSON.stringify(result.state.windows) !== JSON.stringify(state.windows);
    state = result.state;
    if (changed) scheduleSave();
    arm();
    if (result.events.length) emit(result.events);
    if (changed) onChange();
    return result.events.length;
  }

  async function boot() {
    let text = null;
    try {
      text = await readFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`limits read failed: ${error}`);
    }
    if (text !== null) {
      try {
        const parsed = JSON.parse(text);
        if (!validState(parsed)) throw new Error('unexpected shape');
        state = { ...emptyState(), ...parsed, windows: { ...emptyState().windows, ...parsed.windows } };
      } catch (error) {
        log(`limits file is corrupt, starting empty: ${error}`);
        state = emptyState();
      }
    }
    // Persist right away when something fired, so a second boot cannot ring it again.
    if (recheck() > 0) await flush();
  }

  function snapshot() {
    const t = now();
    // A window past its reset is history, whatever the last recheck saw.
    const windows = {};
    for (const [name, win] of Object.entries(state.windows)) windows[name] = win && win.resetsAt > t ? win : null;
    const seen = Object.values(state.windows).filter(Boolean).map((w) => w.seenAt);
    const seenAt = seen.length ? Math.max(...seen) : null;
    return {
      windows,
      shares: shares({ ...state, windows }),
      stale: seenAt === null || t - seenAt > STALE_AFTER_MS,
      seenAt,
      settings: { ...cfg() },
    };
  }

  // The settings changed (windows on/off, threshold): the alarm may differ now.
  function reconfigure() {
    arm();
    onChange();
  }

  function stop() {
    if (alarm !== null) clearTimer(alarm);
    alarm = null;
  }

  return { ingest, recheck, snapshot, boot, flush, reconfigure, stop };
}

// Copies the tap next to a package.json that makes it an ES module (the copy
// lives outside the app, and an old Node would read a bare .js as CommonJS).
// Atomic, and only when it changed.
export function installTapScript({ source, dir }) {
  const target = path.join(dir, TAP_SCRIPT_NAME);
  const content = fs.readFileSync(source, 'utf8');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{"type":"module"}\n');
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    // first install
  }
  if (current === content) return target;
  fs.writeFileSync(`${target}.tmp`, content);
  fs.renameSync(`${target}.tmp`, target);
  return target;
}

const sameLine = (current, original) => {
  const hasCommand = typeof current?.command === 'string' && current.command.trim() !== '';
  if (!original) return !hasCommand;
  return JSON.stringify(current) === JSON.stringify(original);
};

// Installs or removes the tap in the dev's settings.json. The sidecar (the
// dev's original statusLine) is written BEFORE the tap goes in and deleted
// only AFTER the original is back. A statusLine that is neither the tap nor
// the recorded original is the dev's new choice: reported, never overwritten.
export function syncStatusLineTap({ enabled, tapCommand, readSettings, writeSettings, readOriginal, writeOriginal, removeOriginal }) {
  const settings = readSettings();
  if (!isObject(settings)) return { installed: false, replaced: false, changed: false };
  const tapped = isStatusLineTap(settings.statusLine?.command);

  if (!enabled) {
    let changed = false;
    if (tapped) {
      const original = readOriginal();
      writeSettings(removeStatusLine(settings, original ?? null));
      changed = true;
    }
    if (tapped || readOriginal() !== undefined) removeOriginal();
    return { installed: false, replaced: false, changed };
  }

  if (!tapped) {
    const recorded = readOriginal();
    if (recorded !== undefined && !sameLine(settings.statusLine, recorded)) {
      return { installed: false, replaced: true, changed: false };
    }
  }
  const result = ensureStatusLine(settings, tapCommand);
  // undefined = already tapped: the sidecar keeps what it has.
  if (result.original !== undefined && readOriginal() === undefined) writeOriginal(result.original);
  const changed = JSON.stringify(result.settings) !== JSON.stringify(settings);
  if (changed) writeSettings(result.settings);
  return { installed: true, replaced: false, changed };
}
