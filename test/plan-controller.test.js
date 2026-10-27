import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlanController } from '../src/renderer/work/plan-controller.js';

const step = (n, over = {}) => ({ n, text: `passo ${n}`, done: false, why: null, dev: false, reviewed: false, checkpoint: false, restorePoint: over.checkpoint ?? false, ...over });
const baseTask = (over = {}) => ({
  issue: 7, phase: 'steps', mode: 'step', quick: false, title: '', error: null,
  contract: [{ text: 'a → b' }], contractApproved: true,
  tests: { files: ['t.js'], command: 'npm t', locked: ['t.js'], changedLocked: [], contractFilesChanged: false },
  run: { running: false, last: null }, steps: [step(1, { done: true, checkpoint: true }), step(2)], current: 2, devTodos: [],
  working: false, openAnyway: false, pr: { ready: false, blockers: ['x'] }, ...over,
});

// No DOM in the test run: el is a string holder, and the buttons are read back
// out of the html the controller drew.
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function buttons(html) {
  return [...html.matchAll(/<button([^>]*)>/g)].map(([, raw]) => {
    const dataset = {};
    for (const [, name, value] of raw.matchAll(/data-([\w-]+)="([^"]*)"/g)) dataset[name.replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = unescape(value);
    return { dataset, disabled: /\sdisabled(\s|$)/.test(raw) };
  });
}

let el;
let listeners;
let api;
let session;
let task;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const make = (extra = {}) => {
  const controller = createPlanController({
    el, api, sessionId: () => 's1', getSession: () => session, plans: () => ({}), onStepDiff: extra.onStepDiff, onOpenFile: extra.onOpenFile,
  });
  controller.render();
  return controller;
};
// "ui=confirm kind=restore": the first button carrying those data attributes.
const find = (spec) => {
  const want = Object.fromEntries(spec.split(' ').map((pair) => pair.split('=')));
  return buttons(el.innerHTML).find((b) => Object.entries(want).every(([k, v]) => b.dataset[k] === v));
};
const has = (spec) => Boolean(find(spec));
const click = (spec) => {
  const node = find(spec);
  if (!node) throw new Error(`no button ${spec}`);
  return listeners.click({ target: { closest: () => node } });
};
const type = (key, value) => listeners.input({ target: { dataset: { key }, value } });

beforeEach(() => {
  listeners = {};
  el = { innerHTML: '', addEventListener: (type, fn) => (listeners[type] = fn), contains: () => false, querySelectorAll: () => [] };
  session = { question: null, blocksTyping: false };
  task = baseTask();
  api = {
    taskState: vi.fn(async () => task),
    task: vi.fn(async () => ({ ok: true })),
    planAction: vi.fn(async () => 'sent'),
    agentsAnswer: vi.fn(async () => 'sent'),
  };
});

describe('the plan controller', () => {
  it('asks main for the task once and draws the card', async () => {
    const controller = make();
    await flush();
    controller.render();
    expect(api.taskState).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toContain('task-card');
  });

  it('a chat with no task draws the old plan', async () => {
    api.taskState = vi.fn(async () => null);
    createPlanController({ el, api, sessionId: () => 's1', plans: () => ({ s1: { steps: [{ text: 'x', done: false }], approved: false } }) }).render();
    await flush();
    expect(has('plan=approve')).toBe(true);
  });

  it('a contract task never shows the old approve even if the old plan is unapproved', async () => {
    make();
    await flush();
    expect(has('plan=approve')).toBe(false);
  });

  it('task buttons call the service with their action and step', async () => {
    make();
    await flush();
    click('task=undoStep');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'undoStep', 1);
    click('task=setMode arg=trust');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'setMode', 'trust');
  });

  it('restore asks first and only then calls', async () => {
    make();
    await flush();
    click('ui=confirm kind=restore');
    expect(api.task).not.toHaveBeenCalled();
    expect(has('task=restoreBefore')).toBe(true);
    click('task=restoreBefore');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'restoreBefore', 1);
  });

  it('cancel drops the confirmation', async () => {
    make();
    await flush();
    click('ui=confirm kind=unlock');
    click('ui=cancel');
    expect(has('task=unlockTests')).toBe(false);
    expect(api.task).not.toHaveBeenCalled();
  });

  it('unlock asks first and only then calls', async () => {
    make();
    await flush();
    click('ui=confirm kind=unlock');
    expect(api.task).not.toHaveBeenCalled();
    click('task=unlockTests');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'unlockTests', undefined);
  });

  it('a disabled button sends nothing', async () => {
    task = baseTask({ working: true });
    make();
    await flush();
    click('ui=confirm kind=restore');
    expect(has('task=restoreBefore')).toBe(false);
  });

  it('a refusal from main shows as a note, escaped', async () => {
    api.task = vi.fn(async () => ({ error: '<b>não</b>' }));
    make();
    await flush();
    click('task=okNext');
    await flush();
    expect(el.innerHTML).toContain('&#60;b&#62;não&#60;/b&#62;');
    expect(el.innerHTML).not.toContain('<b>não');
  });

  it('a delivery that did not land shows its note', async () => {
    api.task = vi.fn(async () => ({ ok: true, delivery: 'timeout' }));
    make();
    await flush();
    click('task=okNext');
    await flush();
    expect(el.innerHTML).toContain('1 minuto');
  });

  it('answers a pending question from the field and keeps the draft meanwhile', async () => {
    session = { question: 'qual?', blocksTyping: false };
    const controller = make();
    await flush();
    type('answer', 'azul');
    controller.render();
    expect(el.innerHTML).toContain('>azul</textarea>');
    click('ui=answer');
    await flush();
    expect(api.agentsAnswer).toHaveBeenCalledWith('s1', 'azul');
  });

  it('a question that turned into a dialog sends nothing', async () => {
    session = { question: 'qual?', blocksTyping: false };
    make();
    await flush();
    type('answer', 'azul');
    session = { question: 'qual?', blocksTyping: true };
    click('ui=answer');
    await flush();
    expect(api.agentsAnswer).not.toHaveBeenCalled();
  });

  it('an unconfirmed text question shows no field', async () => {
    session = { question: 'qual?', blocksTyping: true };
    make();
    await flush();
    expect(has('key=answer')).toBe(false);
    expect(el.innerHTML).toContain('qual?');
  });

  it('editing a case, asking for another and commenting go to the chat as comments', async () => {
    task = baseTask({ phase: 'contract', contractApproved: false });
    make();
    await flush();
    type('case:0', 'x → y');
    click('ui=edit-case');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'comment', expect.stringContaining('x → y'));
    click('ui=ask-case');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'comment', expect.stringContaining('mais um caso'));
  });

  it('comments on a step', async () => {
    make();
    await flush();
    click('ui=comment n=1');
    type('comment', 'renomeie');
    click('ui=send-comment');
    await flush();
    expect(api.task).toHaveBeenCalledWith('s1', 'comment', 'Sobre o passo 1 (passo 1): renomeie');
  });

  it('the step diff and the TODO open through the wiring', async () => {
    task = baseTask({ steps: [step(1, { done: true, checkpoint: true }), step(2, { dev: true })], devTodos: [{ file: 'a.js', line: 3, note: 'n' }] });
    const onStepDiff = vi.fn();
    const onOpenFile = vi.fn();
    make({ onStepDiff, onOpenFile });
    await flush();
    click('ui=step-diff');
    click('ui=open-file');
    expect(onStepDiff).toHaveBeenCalledWith(1);
    expect(onOpenFile).toHaveBeenCalledWith('a.js', 3);
  });

  it('the PR button goes through the plan action', async () => {
    task = baseTask({ phase: 'pr', pr: { ready: true, blockers: [] } });
    make();
    await flush();
    click('plan=pr');
    await flush();
    expect(api.planAction).toHaveBeenCalledWith('s1', 'pr');
  });
});
