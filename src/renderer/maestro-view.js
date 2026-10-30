// The Maestro stage (#159), as HTML strings: the orchestra on the left, the
// balloon and the held order over the code, the consequences under it and
// the impact on the right. Pure, like workspace-view: vitest checks it and
// workspace.js puts it on screen. Everything from a chat is escaped.
import { STATUS_LABEL, escapeHtml } from './workspace-view.js';

const BALLOON_MAX = 280;
const CONSEQUENCE_LINES = 3;

const plain = (text) =>
  String(text ?? '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const fileName = (filePath) => String(filePath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

export function balloonText(text, max = BALLOON_MAX) {
  const full = plain(text);
  if (full.length <= max) return { short: full, full, cut: false };
  return { short: `${full.slice(0, max).replace(/\s+\S*$/, '')}…`, full, cut: true };
}

// orders: sessionId → the label of the gerente's pending order for it (#162).
export function renderOrchestra(orchestra, focusedId, orders = {}) {
  const rows = orchestra.map(
    (musician) =>
      `<button class="musician" data-musician="${escapeHtml(musician.sessionId)}"${
        musician.sessionId === focusedId ? ' aria-current="true"' : ''
      }><span class="musician-dot" style="background:${escapeHtml(musician.color)}"></span><span class="musician-text"><b>${escapeHtml(
        musician.name,
      )}</b> ${escapeHtml(musician.label)}<span class="musician-status">${escapeHtml(STATUS_LABEL[musician.status] ?? musician.status)}</span>${
        orders[musician.sessionId] ? `<span class="musician-order">↪ quando terminar: ${escapeHtml(orders[musician.sessionId])}</span>` : ''
      }</span></button>`,
  );
  const empty = orchestra.length ? '' : '<div class="orchestra-empty">nenhum chat do Claude aberto no workspace</div>';
  return `<div class="maestro-title">orquestra</div>${rows.join('')}${empty}<div class="musician manager"><span class="musician-dot"></span><span class="musician-text">gerente · ${(() => {
    const count = Object.keys(orders).length;
    return count ? `segue ${count} ${count === 1 ? 'ordem' : 'ordens'}` : 'segue suas ordens';
  })()}</span></div>`;
}

// say: { source, text }, source a session id or 'manager'.
// full: the whole text, after a click on "ver tudo".
export function renderBalloon(say, musicianOf, { full = false } = {}) {
  if (!say?.text) return '';
  const musician = say.source === 'manager' ? null : musicianOf(say.source);
  const who = musician ? `${musician.name}:` : 'gerente:';
  const text = balloonText(say.text);
  const shown = full ? text.full : text.short;
  const more = text.cut && !full ? ' <button class="balloon-more" data-balloon-more>ver tudo</button>' : '';
  return `<div class="balloon${full ? ' full' : ''}"><span class="balloon-who">${escapeHtml(who)}</span> ${escapeHtml(shown)}${more}</div>`;
}

export function renderOrder(order, now = Date.now()) {
  if (!order) return '';
  const seconds = Math.max(0, Math.ceil((order.until - now) / 1000));
  return `<div class="maestro-order">entendi: ${escapeHtml(order.label)} · cancela em ${seconds}s <span class="order-hint">("cancela" ou "manda")</span></div>`;
}

export function renderImpact(musician) {
  const files = musician?.files ?? [];
  const rows = files.map(
    (file) =>
      `<li${file.writing ? ' class="writing"' : ''}><span class="impact-file">${escapeHtml(fileName(file.filePath))}</span>${
        file.added !== null && file.added !== undefined ? ` <span class="added">+${file.added}</span>` : ''
      }${file.removed !== null && file.removed !== undefined ? ` <span class="removed">−${file.removed}</span>` : ''}</li>`,
  );
  return `<div class="maestro-title">área de impacto · o grafo chega na parte 2</div>${
    rows.length ? `<ul class="impact-files">${rows.join('')}</ul>` : '<div class="impact-empty">nada tocado ainda nesta tarefa</div>'
  }`;
}

export function renderConsequences(lines) {
  const last = (lines ?? []).slice(-CONSEQUENCE_LINES);
  return `<div class="maestro-title">consequências</div>${last.map((line) => `<div class="consequence">${escapeHtml(line)}</div>`).join('')}`;
}

// --- the backstage (#142): collapsed to a row of chips, a click opens one ---
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOG_LINE_MAX = 200;

export function cleanLogLine(text) {
  const plain = String(text ?? '').replace(ANSI, '').replace(/\r/g, '');
  return escapeHtml(plain.length > LOG_LINE_MAX ? `${plain.slice(0, LOG_LINE_MAX)}…` : plain);
}

function subagentsChip(subagents) {
  const running = subagents.filter((agent) => agent.running).length;
  if (running) return `⚙ ${running} ${running === 1 ? 'sub-agente rodando' : 'sub-agentes rodando'}`;
  return `⚙ ${subagents.length} ${subagents.length === 1 ? 'sub-agente' : 'sub-agentes'} (terminaram)`;
}

function backstageDetail(backstage, open) {
  if (open === 'subagents')
    return backstage.subagents
      .map(
        (agent) =>
          `<div class="backstage-item"><b>${escapeHtml(agent.type)}</b> ${escapeHtml(agent.description)} <span class="backstage-state">${
            agent.running ? `rodando${agent.lastTool ? ` · ${escapeHtml(agent.lastTool)}` : ''}` : 'terminou'
          }</span>${agent.files.length ? `<div class="backstage-files">${agent.files.map((file) => escapeHtml(file.split(/[\\/]/).pop())).join(', ')}</div>` : ''}</div>`,
      )
      .join('');
  if (open === 'background')
    return backstage.background
      .map(
        (item) =>
          `<div class="backstage-item"><b>$ ${cleanLogLine(item.command)}</b>${
            item.gone
              ? ' <span class="backstage-state">terminado</span>'
              : item.idleSeconds > 60
                ? ` <span class="backstage-state">parado há ${Math.round(item.idleSeconds / 60)} min</span>`
                : ''
          }<pre class="backstage-log">${item.lines
            .map(cleanLogLine)
            .join('\n')}</pre></div>`,
      )
      .join('');
  if (open === 'ports')
    return backstage.ports.map((item) => `<div class="backstage-item"><b>:${item.port}</b> ${escapeHtml(item.process)}</div>`).join('');
  return '';
}

export function renderBackstage(backstage, open) {
  if (!backstage) return '';
  const { subagents = [], background = [], ports = [] } = backstage;
  const chips = [];
  const chip = (kind, text) => chips.push(`<button class="backstage-chip${open === kind ? ' open' : ''}" data-backstage="${kind}">${text}</button>`);
  if (subagents.length) chip('subagents', subagentsChip(subagents));
  if (background.length) chip('background', `▶ ${background.length} em segundo plano`);
  if (ports.length) chip('ports', `⇅ ${ports.map((item) => `:${item.port}`).join(' ')}`);
  if (!chips.length) return '';
  const detail = open ? backstageDetail(backstage, open) : '';
  return `<div class="backstage"><div class="backstage-chips">${chips.join('')}</div>${detail ? `<div class="backstage-detail">${detail}</div>` : ''}</div>`;
}
