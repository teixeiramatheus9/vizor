// The usage limits panel: two window rows, a small SVG line chart and the
// "quem gastou" list. Pure HTML builders; every data string is escaped.
import { escapeHtml } from '../workspace-view.js';

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WINDOWS = [
  { key: 'fiveHour', short: '5h', name: 'Janela de 5 horas' },
  { key: 'sevenDay', short: 'sem', name: 'Janela semanal' },
];
const NEAR_PCT = 80;
const pad = (n) => String(n).padStart(2, '0');

const clock = (ms) => {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// "volta às HH:MM" when it is today, "volta qui HH:MM" otherwise.
export function backLabel(resetsAt, now) {
  const same = new Date(now).toDateString() === new Date(resetsAt).toDateString();
  return same ? `volta às ${clock(resetsAt)}` : `volta ${WEEKDAYS[new Date(resetsAt).getDay()]} ${clock(resetsAt)}`;
}

export const minutesAgo = (seenAt, now) => Math.max(0, Math.floor((now - seenAt) / 60000));

// The windows worth showing: watched and not past their reset.
export function liveWindows(snapshot, now) {
  return WINDOWS.filter(({ key }) => snapshot?.settings?.[key] !== false && snapshot?.windows?.[key] && !(snapshot.windows[key].resetsAt <= now)).map((meta) => ({
    ...meta,
    ...snapshot.windows[meta.key],
  }));
}

// text like "5h 62% · sem 40%"; level ok / near (>= 80) / out (>= 100) / stale.
export function limitsLabel(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.settings?.showInStatusBar === false) return null;
  const live = liveWindows(snapshot, now);
  const worst = live.reduce((max, win) => Math.max(max, win.pct), 0);
  let level = worst >= 100 ? 'out' : worst >= NEAR_PCT ? 'near' : 'ok';
  let title = live.map((win) => `${win.name}: ${Math.round(win.pct)}% · ${backLabel(win.resetsAt, now)}`).join('\n') || 'Limites do Claude: sem leitura ainda';
  if (snapshot.stale && snapshot.seenAt) {
    level = 'stale';
    title += `\nvisto há ${minutesAgo(snapshot.seenAt, now)} min`;
  }
  const text = live.map((win) => `${win.short} ${Math.round(win.pct)}%`).join(' · ') || 'limites';
  return { text, level, title };
}

function row(win, now) {
  const pct = Math.max(0, Math.min(100, Math.round(win.pct)));
  const level = pct >= 100 ? 'out' : pct >= NEAR_PCT ? 'near' : 'ok';
  return [
    `<div class="lim-row" data-window="${win.key}" data-level="${level}">`,
    `<span class="lim-name">${escapeHtml(win.name)}</span>`,
    `<span class="lim-pct">${pct}%</span>`,
    `<span class="lim-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span class="lim-fill" style="width:${pct}%"></span></span>`,
    `<span class="lim-back">${escapeHtml(backLabel(win.resetsAt, now))}</span>`,
    '</div>',
  ].join('');
}

// One polyline per window with history; x is time over the shared span, y is 0-100%.
export function limitsChart(windows) {
  const W = 300;
  const H = 70;
  const withHistory = windows.filter((win) => Array.isArray(win.history) && win.history.length >= 2);
  if (!withHistory.length) return '';
  const times = withHistory.flatMap((win) => win.history.map(([t]) => t));
  const min = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - min);
  const paths = withHistory.map((win) => {
    const d = win.history
      .map(([t, pct], i) => `${i ? 'L' : 'M'}${(((t - min) / span) * W).toFixed(1)} ${(H - (Math.max(0, Math.min(100, pct)) / 100) * H).toFixed(1)}`)
      .join(' ');
    return `<path class="lim-line lim-line-${win.key}" d="${d}" fill="none" />`;
  });
  return `<svg class="lim-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Uso ao longo do tempo">${paths.join('')}</svg>`;
}

// nameOf(sessionId, cwd) -> display name; the caller resolves from the registry.
function shareList(snapshot, nameOf) {
  const chats = snapshot?.shares?.chats ?? [];
  const items = chats.map((chat) => `<li><span class="lim-who">${escapeHtml(nameOf(chat.sessionId, chat.cwd))}</span><span class="lim-share">≈${Math.round(chat.pct)}%</span></li>`);
  const outside = snapshot?.shares?.outside;
  if (outside > 0) items.push(`<li><span class="lim-who">fora do Vizor</span><span class="lim-share">≈${Math.round(outside)}%</span></li>`);
  if (!items.length) return '';
  return `<h3 class="lim-sub">Quem gastou</h3><ul class="lim-shares">${items.join('')}</ul>`;
}

const EMPTY = 'Ainda não vi nenhum chat do Claude desde que ativou — abre um e os números aparecem';

export function renderLimitsPanel(snapshot, now = Date.now(), { nameOf = (_id, cwd) => String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? 'chat' } = {}) {
  const live = liveWindows(snapshot, now);
  if (!live.length) return `<div class="lim-panel" role="dialog" aria-label="Limites do Claude"><p class="lim-empty">${escapeHtml(EMPTY)}</p></div>`;
  const stale = snapshot.stale && snapshot.seenAt ? `<p class="lim-stale">visto há ${minutesAgo(snapshot.seenAt, now)} min</p>` : '';
  return `<div class="lim-panel" role="dialog" aria-label="Limites do Claude">${live.map((win) => row(win, now)).join('')}${limitsChart(live)}${stale}${shareList(snapshot, nameOf)}</div>`;
}

// sessionId -> ≈% of the 5h window, only while that window is watched and live.
export function fiveHourShares(snapshot, now = Date.now()) {
  if (!liveWindows(snapshot, now).some((win) => win.key === 'fiveHour')) return {};
  return Object.fromEntries((snapshot.shares?.chats ?? []).filter((chat) => chat.pct > 0).map((chat) => [chat.sessionId, chat.pct]));
}
