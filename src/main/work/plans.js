// Follows each chat's plan file: the one it wrote (.vizor/plano-<task>.md) is
// bound to it and re-read when the hooks say it was written, and on its Stops.
// A chat that wrote none has none, even sharing the folder. The path is always
// <cwd>/.vizor/<checked name> for a cwd the workspace knows. readFile and knownCwd are injected, so this stays testable.
import path from 'node:path';
import { parseChecklist, planFileOf } from './plan.js';
import { APPROVE_PROMPT, OPEN_PR_PROMPT } from './prompts.js';

export function createPlanTracker({ readFile, knownCwd }) {
  const plans = new Map(); // sessionId → { steps, approved }
  const texts = new Map(); // sessionId → the file as read (its Vizor-plano line feeds the graph)
  const reading = new Map(); // sessionId → the latest read's token
  const bound = new Map(); // sessionId → the plan file name it wrote

  const sameSteps = (a, b) => a.length === b.length && a.every((step, index) => step.text === b[index].text);

  async function reread(sessionId, cwd) {
    const token = Symbol(sessionId);
    reading.set(sessionId, token);
    let text = null;
    try {
      text = await readFile(path.join(cwd, '.vizor', bound.get(sessionId)));
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
    // Only the dev approves: a ticked step or an edit to code is no ok. A plan
    // rewritten from scratch waits for the ok again.
    const kept = before && (sameSteps(before.steps, steps) || steps.some((step) => step.done));
    const approved = Boolean(kept && before.approved);
    plans.set(sessionId, { steps, approved });
    texts.set(sessionId, text);
    return true;
  }

  async function onEvent(event) {
    const sessionId = event?.session_id;
    if (typeof sessionId !== 'string' || typeof event.cwd !== 'string' || !knownCwd(event.cwd)) return false;
    if (event.hook_event_name === 'Stop') return bound.has(sessionId) ? reread(sessionId, event.cwd) : false;
    if (event.hook_event_name !== 'PostToolUse') return false;
    const planFile = planFileOf(event);
    if (!planFile) return false;
    bound.set(sessionId, planFile);
    return reread(sessionId, event.cwd);
  }

  return {
    onEvent,
    planOf: (sessionId) => plans.get(sessionId) ?? null,
    textOf: (sessionId) => texts.get(sessionId) ?? null,
    fileOf: (sessionId) => bound.get(sessionId) ?? null,
    approve(sessionId) {
      const plan = plans.get(sessionId);
      if (plan) plans.set(sessionId, { ...plan, approved: true });
    },
    sessions: () => [...plans.keys()],
    forget(sessionId) {
      plans.delete(sessionId);
      texts.delete(sessionId);
      reading.delete(sessionId);
      bound.delete(sessionId);
    },
  };
}

// The card's buttons (and the voice's "aprova o plano", "abre a PR"): the ok
// counts only once it reached the chat, and a click while one still waits for
// the chat's turn sends nothing more. deliver(sessionId, text) → 'sent' |
// 'failed' | 'timeout', or { error } when the PR is refused.
// refusePr(sessionId) → the reason the task is not ready for its PR, or null.
export function createPlanActions({ planOf, approve, deliver, refusePr = () => null }) {
  const inFlight = new Set();
  return {
    async run(sessionId, action) {
      if (typeof sessionId !== 'string' || !['approve', 'pr'].includes(action)) return 'failed';
      if (action === 'approve' && !planOf(sessionId)) return 'no-plan';
      const refused = action === 'pr' ? refusePr(sessionId) : null;
      if (refused) return { error: refused };
      const key = `${sessionId}:${action}`;
      if (inFlight.has(key)) return 'busy';
      inFlight.add(key);
      try {
        const result = await deliver(sessionId, action === 'approve' ? APPROVE_PROMPT : OPEN_PR_PROMPT);
        if (action === 'approve' && result === 'sent') approve(sessionId);
        return result;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
