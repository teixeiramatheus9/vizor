// Follows each músico's plan file: re-read when the hooks say it was written,
// and on every Stop (a shell command may have written it). The path is always
// <cwd>/.vizor/plano.md for a cwd the workspace knows, never one an event
// names. readFile and knownCwd are injected, so this stays testable.
import path from 'node:path';
import { PLAN_FILE, isPlanEdit, parseChecklist } from './plan.js';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function createPlanTracker({ readFile, knownCwd }) {
  const plans = new Map(); // sessionId → { steps, approved }
  const texts = new Map(); // sessionId → the file as read (its Vizor-plano line feeds the graph)
  const approvedByHand = new Set();
  const reading = new Map(); // sessionId → the latest read's token

  async function reread(sessionId, cwd) {
    const token = Symbol(sessionId);
    reading.set(sessionId, token);
    let text = null;
    try {
      text = await readFile(path.join(cwd, PLAN_FILE));
    } catch {
      // gone or unreadable: no plan
    }
    if (reading.get(sessionId) !== token) return false; // a newer read owns it
    reading.delete(sessionId);
    const steps = parseChecklist(text);
    const before = plans.get(sessionId);
    if (!steps.length) {
      plans.delete(sessionId);
      texts.delete(sessionId);
      return Boolean(before);
    }
    const approved = approvedByHand.has(sessionId) || Boolean(before?.approved) || steps.some((step) => step.done);
    plans.set(sessionId, { steps, approved });
    texts.set(sessionId, text);
    return true;
  }

  async function onEvent(event) {
    const sessionId = event?.session_id;
    if (typeof sessionId !== 'string' || typeof event.cwd !== 'string' || !knownCwd(event.cwd)) return false;
    if (event.hook_event_name === 'Stop') return reread(sessionId, event.cwd);
    if (event.hook_event_name !== 'PostToolUse') return false;
    if (isPlanEdit(event)) return reread(sessionId, event.cwd);
    // Code touched after the plan: it was given the ok.
    const plan = plans.get(sessionId);
    if (plan && !plan.approved && EDIT_TOOLS.has(event.tool_name)) {
      plans.set(sessionId, { ...plan, approved: true });
      return true;
    }
    return false;
  }

  return {
    onEvent,
    planOf: (sessionId) => plans.get(sessionId) ?? null,
    textOf: (sessionId) => texts.get(sessionId) ?? null,
    approve(sessionId) {
      approvedByHand.add(sessionId);
      const plan = plans.get(sessionId);
      if (plan) plans.set(sessionId, { ...plan, approved: true });
    },
    sessions: () => [...plans.keys()],
    forget(sessionId) {
      plans.delete(sessionId);
      texts.delete(sessionId);
      approvedByHand.delete(sessionId);
      reading.delete(sessionId);
    },
  };
}
