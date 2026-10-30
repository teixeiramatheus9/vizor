import { describe, expect, it } from 'vitest';
import { renderPlan } from '../src/renderer/plan-view.js';

const steps = (...done) => done.map((value, index) => ({ text: `passo ${index + 1}`, done: value }));

describe('the plan card', () => {
  it('no steps, nothing drawn', () => {
    expect(renderPlan(null)).toBe('');
    expect(renderPlan({ steps: [], approved: false })).toBe('');
  });

  it('waiting for the ok: counts, marks the first pending step and offers to approve', () => {
    const html = renderPlan({ steps: steps(false, false, false), approved: false });
    expect(html).toContain('Plano · 0/3');
    expect(html).toContain('data-plan="approve"');
    expect(html).not.toContain('data-plan="pr"');
    expect(html.match(/class="plan-step current"/g)).toHaveLength(1);
  });

  it('approved and under way: the done steps ticked, the next one current, no buttons', () => {
    const html = renderPlan({ steps: steps(true, false, false), approved: true });
    expect(html).toContain('Plano · 1/3');
    expect(html).toMatch(/class="plan-step done"[^>]*>✓/);
    expect(html).toMatch(/class="plan-step current"[^>]*>▸ <span>passo 2/);
    expect(html).not.toContain('data-plan="approve"');
    expect(html).not.toContain('data-plan="pr"');
  });

  it('every step done: offers to open the PR', () => {
    const html = renderPlan({ steps: steps(true, true), approved: true });
    expect(html).toContain('Plano · 2/2');
    expect(html).toContain('data-plan="pr"');
  });

  it('a step from the file is escaped', () => {
    const html = renderPlan({ steps: [{ text: '<img src=x onerror=alert(1)>', done: false }], approved: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

import { renderTaskCard } from '../src/renderer/plan-view.js';

const step = (n, over = {}) => ({ n, text: `passo ${n}`, done: false, why: null, dev: false, reviewed: false, checkpoint: false, restorePoint: over.checkpoint ?? false, ...over });
const task = (over = {}) => ({
  issue: 7, phase: 'steps', mode: 'step', quick: false, title: 'Menu', error: null,
  contract: [{ text: 'a → b' }, { text: 'c → d' }], contractApproved: true,
  tests: { files: ['t/a.test.js'], command: 'npx vitest run t/a.test.js', approvedCommand: 'npx vitest run t/a.test.js', locked: ['t/a.test.js'], changedLocked: [], contractFilesChanged: false },
  run: { running: false, last: null }, steps: [step(1, { done: true, checkpoint: true }), step(2)], current: 2, devTodos: [],
  working: false, openAnyway: false, pr: { ready: false, blockers: ['1 passo por fazer'] }, ...over,
});

describe('the task card', () => {
  it('never offers the old "Aprovar plano" on a contract task', () => {
    for (const phase of ['contract', 'tests', 'steps', 'pr']) expect(renderTaskCard(task({ phase }))).not.toContain('data-plan="approve"');
  });

  it('contract phase: editable cases, approve and ask for another case', () => {
    const html = renderTaskCard(task({ phase: 'contract', contractApproved: false }));
    expect(html).toContain('data-key="case:0"');
    expect(html).toContain('data-task="approveContract"');
    expect(html).toContain('data-ui="ask-case"');
    expect(html).not.toContain('data-section="tests"');
  });

  it('a contract error is shown escaped and blocks the approval', () => {
    const html = renderTaskCard(task({ phase: 'contract', error: '<b>ruim</b>' }));
    expect(html).toContain('&lt;b&gt;ruim');
    expect(html).toMatch(/data-task="approveContract"[^>]*disabled/);
  });

  it('a changed locked test shows its diff escaped in a collapsible block under the file', () => {
    const tests = { ...task().tests, changedLocked: ['t/a.test.js'], changedDiffs: { 't/a.test.js': '@@ -1 +1 @@\n-<old>\n+<script>x</script>\n' } };
    const html = renderTaskCard(task({ tests }));
    expect(html).toMatch(/<li><code>t\/a\.test\.js<\/code> <b class="plan-bad">mudou<\/b><details class="plan-diff" data-file="t\/a\.test\.js"><summary>[^<]+<\/summary><pre>/);
    expect(html).toContain('+&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    const none = renderTaskCard(task({ tests: { ...tests, changedDiffs: { 't/a.test.js': null } } }));
    expect(none).toContain('mudou');
    expect(none).not.toContain('plan-diff');
  });

  it('tests phase: the command in full and prominent, files, approve', () => {
    const html = renderTaskCard(task({ phase: 'tests', tests: { ...task().tests, locked: [] } }));
    expect(html).toContain('<code>npx vitest run t/a.test.js</code>');
    expect(html).toContain('plan-command');
    expect(html).toContain('t/a.test.js');
    expect(html).toContain('data-task="approveTests"');
  });

  it('approve tests is off while the run is going or the command is missing', () => {
    expect(renderTaskCard(task({ phase: 'tests', run: { running: true, last: null } }))).toMatch(/data-task="approveTests"[^>]*disabled/);
    expect(renderTaskCard(task({ phase: 'tests', tests: { ...task().tests, command: null } }))).toMatch(/data-task="approveTests"[^>]*disabled/);
  });

  it('the last run: mark, and the tail in an escaped pre', () => {
    const html = renderTaskCard(task({ run: { running: false, last: { status: 'fail', tail: '<script>x</script>', at: 1, ms: 1500 } } }));
    expect(html).toContain('✗');
    expect(html).toContain('<pre>&lt;script&gt;x&lt;/script&gt;</pre>');
    expect(html).not.toContain('<script>');
    expect(renderTaskCard(task({ run: { running: false, last: { status: 'ok', tail: '', at: 1, ms: 0 } } }))).toContain('✓ última execução');
  });

  it('unlocking asks for confirmation first', () => {
    expect(renderTaskCard(task())).toContain('data-ui="confirm" data-kind="unlock"');
    expect(renderTaskCard(task())).not.toContain('data-task="unlockTests"');
    expect(renderTaskCard(task(), { confirming: { kind: 'unlock' } })).toContain('data-task="unlockTests"');
  });

  it('files that changed after the approval: a warning, old ones locked, new ones unlocked', () => {
    const html = renderTaskCard(task({ tests: { ...task().tests, files: ['t/a.test.js', 't/new.test.js'], contractFilesChanged: true } }));
    expect(html).toContain('data-warn="contract-files"');
    expect(html).toMatch(/t\/a\.test\.js<\/code> <i>travado/);
    expect(html).toMatch(/t\/new\.test\.js<\/code> <i>novo, destravado/);
    expect(renderTaskCard(task())).not.toContain('data-warn="contract-files"');
  });

  it('steps: marks, why, diff, comment, undo, restore with its confirmation', () => {
    const html = renderTaskCard(task({ steps: [step(1, { done: true, checkpoint: true, why: 'porque <sim>' }), step(2)] }));
    expect(html).toContain('data-section="steps"');
    expect(html).toContain('✓ <span>passo 1');
    expect(html).toContain('▸ <span>passo 2');
    expect(html).toContain('porque &lt;sim&gt;');
    expect(html).toContain('data-ui="step-diff" data-n="1"');
    expect(html).toContain('data-task="undoStep" data-n="1"');
    expect(html).toContain('data-ui="comment" data-n="1"');
    expect(html).toContain('data-task="okNext"');
    expect(html).not.toContain('data-task="restoreBefore"');
    expect(renderTaskCard(task(), { confirming: { kind: 'restore', n: 1 } })).toContain('data-task="restoreBefore" data-n="1"');
  });

  it('"voltar pra antes deste passo" is off with the agent running and without a checkpoint', () => {
    const off = (html) => /data-kind="restore" data-n="1"[^>]*disabled/.test(html);
    expect(off(renderTaskCard(task()))).toBe(false);
    expect(off(renderTaskCard(task({ working: true })))).toBe(true);
    expect(off(renderTaskCard(task({ steps: [step(1, { done: true, checkpoint: true, restorePoint: false }), step(2)] })))).toBe(true);
  });

  it('"voltar" follows the checkpoint it restores (the one before the step)', () => {
    const off = (html, n) => new RegExp(`data-kind="restore" data-n="${n}"[^>]*disabled`).test(html);
    const on = (html, n) => html.includes(`data-kind="restore" data-n="${n}"`) && !off(html, n);
    // (a) step 1 with only the baseline: its own checkpoint is not there yet, the way back is.
    expect(on(renderTaskCard(task({ steps: [step(1, { done: true, checkpoint: false, restorePoint: true }), step(2)] })), 1)).toBe(true);
    // (b) an undone step whose predecessor's checkpoint exists.
    expect(on(renderTaskCard(task({ steps: [step(1, { done: true, checkpoint: true, restorePoint: true }), step(2, { restorePoint: true })] })), 2)).toBe(true);
    // (c) no point before the step: disabled, with the reason.
    const html = renderTaskCard(task({ steps: [step(1, { done: true, checkpoint: true, restorePoint: false }), step(2)] }));
    expect(off(html, 1)).toBe(true);
    expect(html).toContain('title="não há ponto salvo antes deste passo"');
  });

  it('trust mode: "revisado ✓" per done step, reviewed ones just say so', () => {
    expect(renderTaskCard(task({ mode: 'trust' }))).toContain('data-task="reviewStep"');
    expect(renderTaskCard(task({ mode: 'trust', steps: [step(1, { done: true, reviewed: true }), step(2)] }))).not.toContain('data-task="reviewStep"');
    expect(renderTaskCard(task({ mode: 'step' }))).not.toContain('data-task="reviewStep"');
  });

  it('your turn: the TODO(dev) file:line opens, and "fiz"', () => {
    const html = renderTaskCard(task({ steps: [step(1, { done: true }), step(2, { dev: true })], devTodos: [{ file: 'src/<a>.js', line: 12, note: 'faça <x>' }] }));
    expect(html).toContain('data-section="your-turn"');
    expect(html).toContain('data-ui="open-file" data-file="src/&lt;a&gt;.js" data-line="12"');
    expect(html).toContain('faça &lt;x&gt;');
    expect(html).toContain('data-task="devDone"');
    expect(renderTaskCard(task())).not.toContain('data-section="your-turn"');
  });

  it('a pending question comes first, with the field only when typing is safe', () => {
    const open = renderTaskCard(task(), { question: { text: 'qual <cor>?', blocksTyping: false }, drafts: { answer: 'azul' } });
    expect(open.indexOf('data-section="question"')).toBeLessThan(open.indexOf('data-section="contract"'));
    expect(open).toContain('qual &lt;cor&gt;?');
    expect(open).toContain('data-key="answer"');
    expect(open).toContain('data-ui="answer"');
    const blocked = renderTaskCard(task(), { question: { text: 'qual?', blocksTyping: true } });
    expect(blocked).toContain('qual?');
    expect(blocked).not.toContain('data-key="answer"');
    expect(blocked).not.toContain('data-ui="answer"');
    expect(renderTaskCard(task())).not.toContain('data-section="question"');
  });

  it('footer: mode, quick, end, and the PR with its reasons', () => {
    const html = renderTaskCard(task({ mode: 'trust' }));
    expect(html).toContain('data-task="setMode" data-arg="step"');
    expect(html).toMatch(/data-arg="trust"/);
    expect(html).toContain('data-task="quick"');
    expect(html).toContain('data-task="endTask"');
    expect(html).toMatch(/data-plan="pr"[^>]*disabled/);
    expect(html).toContain('1 passo por fazer');
    expect(html).not.toContain('data-task="openAnyway"');
  });

  it('"abrir assim mesmo" only when unreviewed steps are all that is left', () => {
    const html = renderTaskCard(task({ pr: { ready: false, blockers: ['2 passos sem revisão'] } }));
    expect(html).toContain('data-task="openAnyway"');
    expect(renderTaskCard(task({ pr: { ready: false, blockers: ['o teste do contrato mudou', '2 passos sem revisão'] } }))).not.toContain('data-task="openAnyway"');
    expect(renderTaskCard(task({ pr: { ready: false, blockers: ['o teste do contrato mudou'] } }))).toContain('o teste do contrato mudou');
  });

  it('ready: the PR button is on', () => {
    expect(renderTaskCard(task({ phase: 'pr', pr: { ready: true, blockers: [] } }))).not.toMatch(/data-plan="pr"[^>]*disabled/);
  });

  it('a quick task has no "tarefa rápida" button', () => {
    expect(renderTaskCard(task({ quick: true }))).not.toContain('data-task="quick"');
  });

  it('title and issue are escaped', () => {
    expect(renderTaskCard(task({ title: '<i>x</i>' }))).not.toContain('<i>x</i>');
  });
  it('a new test run keeps the last output on screen', () => {
    const html = renderTaskCard(task({ phase: 'steps', run: { running: true, last: { status: 'fail', tail: 'boom <x>' } } }));
    expect(html).toContain('rodando os testes…');
    expect(html).toContain('plan-run bad');
    expect(html).toContain('boom &lt;x&gt;');
  });
});
