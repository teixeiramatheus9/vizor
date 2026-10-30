// The músico's plan (the core flow): a checklist it writes to a file of its
// own, `.vizor/plano-<task>.md` in the folder it works in, and ticks as it goes.
// The hooks tell the Vizor when it was written; the Vizor reads it from the
// path it computes itself, never from the one the event names. Pure.
import path from 'node:path';

export const MAX_STEPS = 30;
export const MAX_TEXT = 200;
export const CHECK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

const PASSOS_HEADING = /^##\s+Passos\s*$/i;

// The lines the steps live in: the "## Passos" section when the plan has one
// (so a checkbox in the contract or a note never counts), else every line, as
// the old plans (no sections) always did.
export function stepLines(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const start = lines.findIndex((line) => PASSOS_HEADING.test(line));
  if (start < 0) return lines;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

export function parseChecklist(markdown) {
  const steps = [];
  for (const line of stepLines(markdown)) {
    const match = line.match(CHECK_LINE);
    if (!match) continue;
    steps.push({ text: match[2].slice(0, MAX_TEXT), done: match[1] !== ' ' });
    if (steps.length === MAX_STEPS) break;
  }
  return steps;
}

// current: the first step still pending, -1 when none is.
export function planProgress(steps) {
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, current: steps.findIndex((step) => !step.done) };
}

// A task's own file, so chats sharing a folder never share a plan:
// .vizor/plano-169.md (plano.md, with no task, still counts).
const PLAN_NAME = /^plano(-\d{1,6})?\.md$/;
export const planFileName = (number) => `.vizor/plano-${number}.md`;
// The task a plan file name belongs to: plano-169.md → 169; plano.md has none.
export const planIssueOf = (name) => Number(/^plano-(\d{1,6})\.md$/.exec(String(name ?? ''))?.[1]) || null;

// The plan file an edit wrote, as a bare name checked against PLAN_NAME, or
// null. Only <cwd>/.vizor/<name> counts.
export function planFileOf(event) {
  const file = event?.tool_input?.file_path;
  if (!EDIT_TOOLS.has(event?.tool_name) || typeof file !== 'string' || typeof event.cwd !== 'string') return null;
  const name = path.basename(file);
  if (!PLAN_NAME.test(name)) return null;
  return path.resolve(event.cwd, file) === path.join(event.cwd, '.vizor', name) ? name : null;
}

export const isPlanEdit = (event) => planFileOf(event) !== null;

// The plan stays out of git: `.vizor/` joins the repo's info/exclude once.
export function excludeWithPlan(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.some((line) => line.trim() === '.vizor/' || line.trim() === '.vizor')) return null;
  const body = String(text ?? '');
  return `${body}${body && !body.endsWith('\n') ? '\n' : ''}.vizor/\n`;
}
