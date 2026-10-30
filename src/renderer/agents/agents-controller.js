// The Agentes tab: turns the workspace state's flat session list into the
// kanban and handles the cards' actions. No globals: the DOM root, the IPC
// api and the clock come in, so vitest drives it with fakes.
import { columnOf, nextBoundary, sessionCard, stopTimeOf } from '../../main/agents/columns.js';
import { OTHER_PROJECTS, renderFilters, renderKanban } from './kanban-view.js';

// setTimeout takes a signed 32-bit delay; a longer one fires at once.
const MAX_DELAY_MS = 2 ** 31 - 1;
// A hair past the boundary so the clock has surely crossed it when it fires.
const BOUNDARY_SLACK_MS = 50;
const MOVE_MS = 150;

// deps:
//   el            the #view-agents element
//   api           { agentsSeen, agentsDismiss, agentsInterrupt, agentsAnswer,
//                   planAction, answerGuard, focusOutside }
//   projects()    root -> { name, uri, accent } for the workspace's projects
//   openSession(sessionId)   Workspace tab + select + drawer + terminal focus
export function createAgentsController({
  el,
  api,
  projects = () => ({}),
  openSession,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
}) {
  let sessions = [];
  let plans = {};
  let guardAsks = [];
  let visible = false;
  let timer = null;
  let lastHtml = null;
  let rendered = false;
  let hasState = false; // until the first push the board is a skeleton, not "nenhum agente"
  const filter = { project: null, needsMe: false };
  const ui = { answering: null, confirming: null, error: null };
  const marked = new Map(); // session id -> the Stop time it was last marked seen at

  const guardOf = (sessionId) => guardAsks.find((ask) => ask.sessionId === sessionId) ?? null;

  function cards() {
    const at = now();
    return sessions.map((session) => {
      const plan = plans[session.id] ?? null;
      const guardAsk = guardOf(session.id);
      const card = sessionCard(session, { project: session.project, plan, guardAsk, now: at });
      if (guardAsk) card.guardAsk = guardAsk;
      // A plan waiting for the ok has its own button: "Aprovar" alone is a
      // permission ask, answered in the chat's terminal.
      if (plan && !plan.approved && card.column !== 'failed') card.actions.push('approve-plan');
      return card;
    });
  }

  function counts() {
    const at = now();
    const result = { working: 0, waiting: 0 };
    for (const session of sessions) {
      const column = sessionCard(session, { guardAsk: guardOf(session.id), now: at }).column;
      if (column === 'working' || column === 'waiting') result[column]++;
    }
    return result;
  }

  const waitingCount = () => counts().waiting;

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!visible) return;
    const at = now();
    const boundary = nextBoundary(sessions, at, new Set(guardAsks.map((ask) => ask.sessionId)));
    if (boundary === null) return;
    timer = setTimer(() => {
      timer = null;
      render();
    }, Math.min(MAX_DELAY_MS, boundary - at + BOUNDARY_SLACK_MS));
  }

  function projectList() {
    const known = projects();
    return Object.entries(known).map(([root, info]) => ({ root, ...info }));
  }

  // FLIP with transform/opacity only: cards slide from where they were.
  function animate(before) {
    if (reducedMotion() || !before || typeof el.querySelectorAll !== 'function') return;
    for (const card of el.querySelectorAll('[data-card]')) {
      const old = before.get(card.dataset.card);
      const box = card.getBoundingClientRect();
      if (!old) {
        card.style.opacity = '0';
        requestAnimationFrame(() => {
          card.style.transition = `opacity ${MOVE_MS}ms ease-out`;
          card.style.opacity = '1';
        });
        continue;
      }
      const dx = old.left - box.left;
      const dy = old.top - box.top;
      if (!dx && !dy) continue;
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        card.style.transition = `transform ${MOVE_MS}ms ease-out`;
        card.style.transform = '';
      });
    }
  }

  function render() {
    if (!visible) return;
    const all = cards();
    const html = [
      renderFilters(projectList(), { filter, hasOthers: all.some((card) => card.projectRoot === null) }),
      renderKanban(all, { filter, projects: projects(), now: now(), ui, loading: !hasState }),
    ].join('');
    schedule();
    if (html === lastHtml) return;
    lastHtml = html;
    const before = rendered && typeof el.querySelectorAll === 'function' ? new Map([...el.querySelectorAll('[data-card]')].map((card) => [card.dataset.card, card.getBoundingClientRect()])) : null;
    // A state push must not eat what is being typed in a card's reply box.
    const input = el.querySelector?.('.kb-reply-input');
    const typed = input ? { value: input.value, focused: document.activeElement === input } : null;
    el.innerHTML = html;
    rendered = true;
    const fresh = el.querySelector?.('.kb-reply-input');
    if (fresh) {
      if (typed) fresh.value = typed.value;
      if (!typed || typed.focused) fresh.focus();
    }
    animate(before);
  }

  function open(sessionId) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || session.status === 'failed') return;
    api.agentsSeen(sessionId);
    if (session.ptyId) openSession(sessionId);
    else api.focusOutside(sessionId);
  }

  async function submitReply(sessionId, text) {
    const reply = String(text ?? '').trim();
    if (!reply) return;
    const outcome = await api.agentsAnswer(sessionId, reply);
    if (outcome === 'sent' || outcome === 'pasted') {
      ui.answering = null;
      ui.error = null;
    } else {
      ui.error = { id: sessionId, text: 'não consegui enviar' };
    }
    lastHtml = null;
    render();
  }

  function runAction(action, sessionId) {
    if (action === 'focus') return open(sessionId);
    if (action === 'answer') {
      ui.answering = sessionId;
      ui.confirming = null;
      ui.error = null;
    } else if (action === 'approve') {
      // A permission ask lives in the chat's terminal: take the user there.
      return open(sessionId);
    } else if (action === 'approve-plan') {
      api.planAction(sessionId, 'approve');
      return;
    } else if (action === 'interrupt') {
      ui.confirming = sessionId;
      ui.answering = null;
    } else if (action === 'interrupt-confirm') {
      ui.confirming = null;
      ui.error = null;
      Promise.resolve(api.agentsInterrupt(sessionId)).then((outcome) => {
        if (outcome !== 'failed') return;
        ui.error = { id: sessionId, text: 'não deu pra interromper' };
        lastHtml = null;
        render();
      });
    } else if (action === 'cancel') {
      ui.answering = null;
      ui.confirming = null;
      ui.error = null;
    } else if (action === 'dismiss') {
      api.agentsDismiss(sessionId);
      return;
    } else {
      return;
    }
    render();
  }

  el.addEventListener('click', (event) => {
    const target = event.target;
    const chip = target.closest?.('[data-kb-filter]');
    if (chip) {
      if (chip.dataset.kbFilter === 'needsMe') filter.needsMe = !filter.needsMe;
      else filter.project = chip.dataset.value || null;
      render();
      return;
    }
    const guard = target.closest?.('[data-guard-choice]');
    if (guard) {
      guard.closest('.guard-card')?.classList.add('answered');
      api.answerGuard(guard.dataset.guardId, guard.dataset.guardChoice);
      return;
    }
    const button = target.closest?.('[data-action]');
    if (button) {
      runAction(button.dataset.action, button.dataset.cardId);
      return;
    }
    if (target.closest?.('form, input, .guard-card')) return;
    const card = target.closest?.('[data-card]');
    if (card) open(card.dataset.card);
  });

  el.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target.closest?.('.kb-reply');
    if (form) submitReply(form.dataset.cardId, form.querySelector('.kb-reply-input')?.value);
  });

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (ui.answering || ui.confirming)) {
      event.stopPropagation();
      runAction('cancel', null);
    }
  });

  return {
    setState(next) {
      hasState = true;
      sessions = next.sessions ?? [];
      plans = next.plans ?? {};
      guardAsks = next.guardAsks ?? [];
      // A session that left must not keep a reply box or a confirmation open.
      for (const key of ['answering', 'confirming']) if (ui[key] && !sessions.some((session) => session.id === ui[key])) ui[key] = null;
      render();
    },
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) {
        schedule(); // clears the timer
        return;
      }
      lastHtml = null;
      rendered = false;
      render();
    },
    // The chat is in front of the user (its terminal active in a focused
    // window): a finished turn counts as seen. Once per Stop.
    lookingAt(sessionId) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || columnOf(session, { now: now(), guardAsk: Boolean(guardOf(sessionId)) }) !== 'done') return;
      const stop = stopTimeOf(session);
      if (marked.get(sessionId) === stop) return;
      marked.set(sessionId, stop);
      api.agentsSeen(sessionId);
    },
    // The avatars' accents arrive asynchronously: draw again with them.
    refresh: render,
    waitingCount,
    counts,
    hasTimer: () => timer !== null,
    OTHER_PROJECTS,
  };
}
