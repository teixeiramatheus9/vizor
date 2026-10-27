// When an automação runs: parsing, plain-Portuguese description, next run and
// missed runs. Pure: the clock is always passed in. All date math uses local
// Date APIs (setting y/m/d/h/min), so a daylight saving change keeps the
// wall-clock hour instead of drifting by an hour.
export const MIN_INTERVAL_MIN = 15;
export const DAY_MS = 24 * 3600000;

const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = (n) => String(n).padStart(2, '0');

function parseTime(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, min } : null;
}

const fmtAt = (at) => {
  const { h, min } = parseTime(at);
  return min ? `${h}h${pad(min)}` : `${h}h`;
};

function normalize(w) {
  if (!w || typeof w !== 'object') return { error: 'Horário inválido.' };
  if (w.kind === 'every') {
    const minutes = Number(w.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return { error: 'Intervalo inválido.' };
    if (minutes < MIN_INTERVAL_MIN) return { error: `O intervalo mínimo é de ${MIN_INTERVAL_MIN} min.` };
    return { kind: 'every', minutes };
  }
  if (w.kind === 'daily' || w.kind === 'weekdays' || w.kind === 'days') {
    const t = parseTime(w.at);
    if (!t) return { error: 'Horário inválido.' };
    const at = `${pad(t.h)}:${pad(t.min)}`;
    if (w.kind !== 'days') return { kind: w.kind, at };
    const days = [...new Set(Array.isArray(w.days) ? w.days : [])];
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'Escolha ao menos um dia da semana.' };
    return { kind: 'days', days: days.sort((a, b) => a - b), at };
  }
  return { error: 'Tipo de horário desconhecido.' };
}

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function parseClock(s) {
  const m = /^(\d{1,2})(?:h(\d{2})?|:(\d{2}))$/.exec(s.trim());
  return m ? `${m[1]}:${m[2] ?? m[3] ?? '00'}` : null;
}

function parseText(text) {
  const s = strip(text);
  let m = /^a cada (\d+)\s*(min|h)$/.exec(s);
  if (m) return { kind: 'every', minutes: Number(m[1]) * (m[2] === 'h' ? 60 : 1) };
  m = /^(.+?) as (\d.*)$/.exec(s);
  if (!m) return null;
  const at = parseClock(m[2]);
  if (!at) return null;
  if (m[1] === 'todo dia') return { kind: 'daily', at };
  if (m[1] === 'dias uteis') return { kind: 'weekdays', at };
  const names = DAY_NAMES.map(strip);
  const days = m[1].split(/\s*,\s*|\s+e\s+/).map((d) => names.indexOf(d));
  return days.length && days.every((d) => d >= 0) ? { kind: 'days', days, at } : null;
}

export function parseWhen(input) {
  if (typeof input === 'string') {
    const parsed = parseText(input);
    return parsed ? normalize(parsed) : { error: 'Não entendi o horário.' };
  }
  return normalize(input);
}

export function describeWhen(when) {
  switch (when.kind) {
    case 'every':
      return when.minutes % 60 === 0 && when.minutes >= 120 ? `a cada ${when.minutes / 60} h` : `a cada ${when.minutes} min`;
    case 'daily': return `todo dia às ${fmtAt(when.at)}`;
    case 'weekdays': return `dias úteis às ${fmtAt(when.at)}`;
    default: {
      const names = when.days.map((d) => DAY_NAMES[d]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0];
      return `${list} às ${fmtAt(when.at)}`;
    }
  }
}

function runsOn(when, day) {
  if (when.kind === 'daily') return true;
  if (when.kind === 'weekdays') return day >= 1 && day <= 5;
  return when.days.includes(day);
}

// Slot instant on the local calendar day that is `offset` days after `base`'s.
function slotOn(base, offset, at) {
  const { h, min } = parseTime(at);
  const d = new Date(base);
  return { ms: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, h, min).getTime(), day: new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getDay() };
}

export function nextRun(when, { from, lastRun } = {}) {
  if (when.kind === 'every') {
    const due = (lastRun ?? from) + when.minutes * 60000;
    return Math.max(due, from);
  }
  for (let offset = 0; offset <= 8; offset++) {
    const slot = slotOn(from, offset, when.at);
    if (slot.ms > from && runsOn(when, slot.day)) return slot.ms;
  }
  return null;
}

// createdAt is the baseline for an automação that never ran, so a first slot
// that passed while the app was closed still counts as missed.
export function missedRun(when, { lastRun, createdAt, now, graceMs = DAY_MS } = {}) {
  const base = lastRun ?? createdAt;
  if (base == null) return null;
  let latest = null;
  if (when.kind === 'every') {
    const step = when.minutes * 60000;
    const k = Math.floor((now - base) / step);
    if (k >= 1) latest = base + k * step;
  } else {
    const back = Math.ceil(graceMs / DAY_MS) + 1;
    for (let offset = 0; offset >= -back; offset--) {
      const slot = slotOn(now, offset, when.at);
      if (slot.ms <= now && slot.ms > base && runsOn(when, slot.day)) { latest = slot.ms; break; }
    }
  }
  return latest != null && now - latest <= graceMs ? latest : null;
}
