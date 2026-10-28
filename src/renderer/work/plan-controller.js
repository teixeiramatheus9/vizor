// The plan card's wiring: it asks main for the task of the chat in front, draws
// it (a task with a contract: renderTaskCard; a quick one: the old checklist)
// and sends the buttons back. The drafts and the pending confirmation live
// here, so a redraw never eats what the dev is typing.
import { renderPlan, renderTaskCard } from '../plan-view.js';

const PLAN_NOTES = {
  failed: 'não achei a aba desse chat',
  timeout: 'o chat não ficou livre em 1 minuto; tente de novo quando ele parar',
  busy: 'já estou esperando o chat ficar livre pra mandar',
  'no-plan': 'esse chat não tem plano',
};
const DELIVERED = new Set(['sent', 'pasted', undefined, null]);
const escapeNote = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// api: { task(sessionId, action, arg), taskState(sessionId), planAction(sessionId, action), agentsAnswer(sessionId, text) }
// getSession(id): { question: string|null, blocksTyping: boolean } of the agent session.
export function createPlanController({ el, api, sessionId, getSession = () => null, plans = () => ({}), onStepDiff = () => {}, onOpenFile = () => {}, doc = typeof document === 'undefined' ? null : document }) {
  const tasks = new Map(); // sessionId → task state ('none' once main said there is none)
  const asked = new Set();
  let ui = { drafts: {}, confirming: null, commenting: null };
  let note = null; // { sessionId, text }
  let serial = 0;

  function uiFor(id) {
    const session = getSession(id);
    const question = session?.question ? { text: session.question, blocksTyping: Boolean(session.blocksTyping) } : null;
    return { ...ui, question };
  }

  function draw() {
    const id = sessionId();
    if (!id) {
      el.innerHTML = '';
      return;
    }
    const task = tasks.get(id);
    const noteHtml = note?.sessionId === id ? `<div class="plan-note">${escapeNote(note.text)}</div>` : '';
    let html;
    if (task && task !== 'none' && task.phase !== 'quick' && !task.quick) html = renderTaskCard(task, uiFor(id));
    else html = renderPlan(plans()[id]);
    const active = doc?.activeElement && el.contains(doc.activeElement) ? doc.activeElement : null;
    const keep = active?.dataset?.key ? { key: active.dataset.key, start: active.selectionStart, end: active.selectionEnd } : null;
    // A state push redraws the card: the test output the dev opened stays open.
    const tailOpen = Boolean(el.querySelector?.('details.plan-tail')?.open);
    const diffsOpen = new Set([...(el.querySelectorAll?.('details.plan-diff') ?? [])].filter((node) => node.open).map((node) => node.dataset?.file));
    el.innerHTML = html + (html ? noteHtml : '');
    if (tailOpen) {
      const tail = el.querySelector('details.plan-tail');
      if (tail) tail.open = true;
    }
    if (diffsOpen.size) for (const node of el.querySelectorAll('details.plan-diff')) if (diffsOpen.has(node.dataset?.file)) node.open = true;
    if (keep) {
      const back = [...el.querySelectorAll('[data-key]')].find((node) => node.dataset.key === keep.key);
      if (back) {
        back.focus();
        if (keep.start != null) back.setSelectionRange?.(keep.start, keep.end);
      }
    }
  }

  async function refresh(id = sessionId()) {
    if (!id) return;
    const mine = ++serial;
    const state = await api.taskState(id).catch(() => null);
    if (mine !== serial) return;
    tasks.set(id, state ?? 'none');
    draw();
  }

  // Called on every workspace redraw: the first look at a chat asks main.
  function render() {
    const id = sessionId();
    if (id && !asked.has(id)) {
      asked.add(id);
      refresh(id);
    }
    draw();
  }

  const say = (id, text) => {
    note = text ? { sessionId: id, text } : null;
  };

  async function runTask(id, action, arg) {
    const result = await api.task(id, action, arg);
    say(id, result?.error ?? (DELIVERED.has(result?.delivery) ? null : PLAN_NOTES[result.delivery] ?? String(result.delivery)));
    ui = { ...ui, confirming: null };
    await refresh(id);
    return result;
  }

  const draftOf = (key) => String(ui.drafts[key] ?? '').trim();
  const clearDraft = (key) => {
    const { [key]: _gone, ...rest } = ui.drafts;
    ui = { ...ui, drafts: rest };
  };

  async function localAction(id, node) {
    const { ui: name } = node.dataset;
    const n = Number(node.dataset.n);
    if (name === 'confirm') ui = { ...ui, confirming: { kind: node.dataset.kind, n: Number.isFinite(n) ? n : null } };
    else if (name === 'cancel') ui = { ...ui, confirming: null };
    else if (name === 'comment') ui = { ...ui, commenting: ui.commenting === n ? null : n };
    else if (name === 'step-diff') return onStepDiff(n, { issue: tasks.get(id)?.issue ?? null, worktree: tasks.get(id)?.worktree ?? null, total: tasks.get(id)?.steps?.length ?? null });
    else if (name === 'open-file') return onOpenFile(node.dataset.file, Number(node.dataset.line));
    else if (name === 'answer') {
      // Asked again now: the question may have turned into a dialog since the card was drawn.
      const text = draftOf('answer');
      if (!text || getSession(id)?.blocksTyping) return draw();
      const outcome = await api.agentsAnswer(id, text);
      if (outcome === 'sent' || outcome === 'pasted') clearDraft('answer');
      else say(id, 'não consegui enviar');
    } else if (name === 'edit-case') {
      const key = `case:${node.dataset.i}`;
      const text = draftOf(key);
      const original = tasks.get(id)?.contract?.[Number(node.dataset.i)]?.text;
      if (!text || text === original) return draw();
      clearDraft(key);
      return runTask(id, 'comment', `No contrato, troque o caso ${Number(node.dataset.i) + 1} (\`${original}\`) por: ${text}`);
    } else if (name === 'ask-case') {
      const text = draftOf('extra');
      clearDraft('extra');
      return runTask(id, 'comment', text ? `Acrescente este caso ao contrato: ${text}` : 'Acrescente mais um caso ao contrato (situação → resultado) que eu ainda não cobri.');
    } else if (name === 'send-comment') {
      const text = draftOf('comment');
      const step = tasks.get(id)?.steps?.find((item) => item.n === n);
      if (!text || !step) return draw();
      clearDraft('comment');
      ui = { ...ui, commenting: null };
      return runTask(id, 'comment', `Sobre o passo ${n} (${step.text}): ${text}`);
    }
    return draw();
  }

  el.addEventListener('input', (event) => {
    const key = event.target?.dataset?.key;
    if (key) ui = { ...ui, drafts: { ...ui.drafts, [key]: event.target.value } };
  });

  el.addEventListener('click', async (event) => {
    const node = event.target.closest('button');
    const id = sessionId();
    if (!node || !id || node.disabled) return;
    if (node.dataset.ui) return localAction(id, node);
    if (node.dataset.task) {
      const arg = node.dataset.n !== undefined ? Number(node.dataset.n) : node.dataset.arg;
      node.disabled = true;
      return runTask(id, node.dataset.task, arg);
    }
    if (node.dataset.plan) {
      node.disabled = true;
      const result = await api.planAction(id, node.dataset.plan);
      say(id, PLAN_NOTES[result] ?? result?.error ?? null);
      await refresh(id);
    }
  });

  return { render, refresh, taskOf: (id) => { const task = tasks.get(id); return task && task !== 'none' ? task : null; }, forget: (id) => { tasks.delete(id); asked.delete(id); } };
}
