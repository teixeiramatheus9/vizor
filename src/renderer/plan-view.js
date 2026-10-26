// The músico's plan, live: the checklist it keeps in .vizor/plano.md, with
// the one step it is on marked, the ok it waits for and the PR once it is all
// done. Pure, like maestro-view; every step comes from a file and is escaped.
import { escapeHtml } from './workspace-view.js';

// plan: { steps: [{ text, done }], approved }.
export function renderPlan(plan) {
  const steps = plan?.steps ?? [];
  if (!steps.length) return '';
  const done = steps.filter((step) => step.done).length;
  const current = steps.findIndex((step) => !step.done);
  const rows = steps.map((step, index) => {
    const state = step.done ? 'done' : index === current ? 'current' : 'pending';
    const mark = step.done ? '✓' : index === current ? '▸' : '○';
    return `<li class="plan-step ${state}">${mark} <span>${escapeHtml(step.text)}</span></li>`;
  });
  const action = !plan.approved
    ? '<button class="plan-action" data-plan="approve">Aprovar plano</button>'
    : current === -1
      ? '<button class="plan-action" data-plan="pr">Abrir PR</button>'
      : '';
  return `<div class="plan-card"><div class="plan-head"><b>Plano · ${done}/${steps.length}</b>${
    plan.approved ? '' : '<span class="plan-wait">esperando seu ok</span>'
  }</div><ol class="plan-steps">${rows.join('')}</ol>${action}</div>`;
}
