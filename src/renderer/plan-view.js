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

// --- The card of a task with a contract ---------------------------------------
// task: what task-service's state() returns. ui: what only the card knows: the
// pending question ({ text, blocksTyping }), the drafts the dev is typing, the
// button waiting for its confirmation and the step being commented.
const e = escapeHtml;
const attrs = (pairs) => Object.entries(pairs).map(([key, value]) => ` data-${key}="${e(value)}"`).join('');
const button = (label, data, { disabled = false, title = '', cls = 'plan-link' } = {}) =>
  `<button class="${cls}"${attrs(data)}${disabled ? ' disabled' : ''}${title ? ` title="${e(title)}"` : ''}>${e(label)}</button>`;
const section = (name, title, body) => `<section class="plan-section" data-section="${name}"><h4>${e(title)}</h4>${body}</section>`;

function questionSection(ui) {
  if (!ui.question?.text) return '';
  const { text, blocksTyping } = ui.question;
  // Typing into a dialog would answer it by accident: the field only exists when claude's input box is free.
  const field = blocksTyping
    ? '<p class="plan-hint">responda no terminal do chat</p>'
    : `<textarea class="plan-input" rows="2" data-key="answer" placeholder="sua resposta">${e(ui.drafts?.answer ?? '')}</textarea>${button('responder', { ui: 'answer' }, { cls: 'plan-action' })}`;
  return section('question', 'Pergunta pendente', `<p class="plan-question">${e(text)}</p>${field}`);
}

function contractSection(task, ui) {
  const cases = task.contract ?? [];
  const editable = task.phase === 'contract';
  const rows = cases.map((item, index) => {
    if (!editable) return `<li>${e(item.text)}</li>`;
    const key = `case:${index}`;
    return `<li><input class="plan-input" data-key="${key}" value="${e(ui.drafts?.[key] ?? item.text)}">${button('trocar', { ui: 'edit-case', i: index })}</li>`;
  });
  const error = task.error ? `<p class="plan-warn">${e(task.error)}</p>` : '';
  const actions = editable
    ? `<div class="plan-row"><input class="plan-input" data-key="extra" placeholder="outro caso (situação → resultado)" value="${e(ui.drafts?.extra ?? '')}">${button('pedir outro caso', { ui: 'ask-case' })}</div>
       ${button('Aprovar contrato', { task: 'approveContract' }, { disabled: Boolean(task.error) || !cases.length, cls: 'plan-action' })}`
    : '<p class="plan-ok">contrato aprovado ✓</p>';
  return section('contract', 'Contrato', `${error}<ul class="plan-cases">${rows.join('')}</ul>${actions}`);
}

function runBlock(run) {
  if (run?.running) return '<p class="plan-hint">rodando os testes…</p>';
  const last = run?.last;
  if (!last) return '';
  const ok = last.status === 'ok';
  const secs = last.ms ? ` · ${(last.ms / 1000).toFixed(1)} s` : '';
  const tail = last.tail ? `<details class="plan-tail"><summary>fim da saída</summary><pre>${e(last.tail)}</pre></details>` : '';
  return `<p class="plan-run ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} última execução: ${e(last.status)}${secs}</p>${tail}`;
}

function testsSection(task, ui) {
  const tests = task.tests ?? {};
  const locked = new Set(tests.locked ?? []);
  const changed = new Set(tests.changedLocked ?? []);
  const files = (tests.files ?? []).map((file) => {
    const mark = changed.has(file) ? ' <b class="plan-bad">mudou</b>' : locked.has(file) ? ' <i>travado</i>' : locked.size ? ' <i>novo, destravado</i>' : '';
    return `<li><code>${e(file)}</code>${mark}</li>`;
  });
  // Files the plan dropped stay locked: they are not in the list but the dev must see them.
  const dropped = [...locked].filter((file) => !(tests.files ?? []).includes(file)).map((file) => `<li><code>${e(file)}</code> <i>travado, fora da lista do plano</i></li>`);
  const warn = tests.contractFilesChanged
    ? '<p class="plan-warn" data-warn="contract-files">A lista de arquivos do contrato mudou depois da aprovação: os arquivos já travados continuam travados e os novos ficam destravados.</p>'
    : '';
  const changedWarn = changed.size ? '<p class="plan-warn">Um arquivo de teste travado foi alterado.</p>' : '';
  const command = tests.command
    ? `<div class="plan-command"><span>comando que será rodado</span><code>${e(tests.command)}</code></div>`
    : '<p class="plan-warn">Falta a linha Vizor-teste com o comando no plano.</p>';
  const approving = task.phase === 'tests';
  const approve = approving
    ? button('Aprovar testes', { task: 'approveTests' }, { disabled: !tests.command || !(tests.files ?? []).length || Boolean(task.run?.running), cls: 'plan-action' })
    : '';
  const unlock = locked.size ? unlockControl(ui) : '';
  return section('tests', 'Testes', `${warn}${changedWarn}<ul class="plan-files">${files.join('')}${dropped.join('')}</ul>${command}${runBlock(task.run)}${approve}${unlock}`);
}

function unlockControl(ui) {
  if (ui.confirming?.kind === 'unlock') {
    return `<p class="plan-confirm">Destravar os testes deixa o chat mexer neles; terão de ser aprovados de novo. ${button('sim, destravar', { task: 'unlockTests' }, { cls: 'plan-action' })} ${button('cancelar', { ui: 'cancel' })}</p>`;
  }
  return button('destravar os testes', { ui: 'confirm', kind: 'unlock' });
}

function stepRow(task, step, ui, lastDone) {
  const current = step.n === task.current;
  const state = step.done ? 'done' : current ? 'current' : 'pending';
  const mark = step.done ? '✓' : current ? '▸' : '○';
  const why = step.why ? `<small class="plan-why">${e(step.why)}</small>` : '';
  const tag = step.dev ? ' <b class="plan-dev">[dev]</b>' : '';
  const tools = [];
  if (step.done) {
    if (step.checkpoint) tools.push(button('ver o diff deste passo', { ui: 'step-diff', n: step.n }));
    if (step.reviewed) tools.push('<span class="plan-ok">revisado ✓</span>');
    else if (task.mode === 'trust') tools.push(button('revisado ✓', { task: 'reviewStep', arg: step.text }));
    if (task.mode === 'step' && lastDone && !task.working) tools.push(button('ok, segue', { task: 'okNext' }, { cls: 'plan-action' }));
    tools.push(button('comentar', { ui: 'comment', n: step.n }));
    tools.push(button('desfazer', { task: 'undoStep', n: step.n }, { disabled: task.working, title: task.working ? 'o agente está trabalhando' : '' }));
  }
  // Back to the files before this step: needs the step's checkpoint and a quiet agent.
  const canRestore = step.checkpoint && !task.working;
  const restoreTitle = task.working ? 'o agente está trabalhando' : !step.checkpoint ? 'este passo não tem ponto salvo' : '';
  if (step.done || step.checkpoint) {
    if (ui.confirming?.kind === 'restore' && ui.confirming.n === step.n) {
      tools.push(`<span class="plan-confirm">Voltar os arquivos pra antes do passo ${step.n}? Nada é apagado. ${button('sim, voltar', { task: 'restoreBefore', n: step.n }, { cls: 'plan-action', disabled: !canRestore })} ${button('cancelar', { ui: 'cancel' })}</span>`);
    } else {
      tools.push(button('voltar pra antes deste passo', { ui: 'confirm', kind: 'restore', n: step.n }, { disabled: !canRestore, title: restoreTitle }));
    }
  }
  const commenting = ui.commenting === step.n
    ? `<div class="plan-row"><input class="plan-input" data-key="comment" placeholder="o que mudar neste passo" value="${e(ui.drafts?.comment ?? '')}">${button('enviar', { ui: 'send-comment', n: step.n })}</div>`
    : '';
  return `<li class="plan-step ${state}" data-step="${step.n}">${mark} <span>${e(step.text)}</span>${tag}${why}<div class="plan-tools">${tools.join(' ')}</div>${commenting}</li>`;
}

function stepsSection(task, ui) {
  const steps = task.steps ?? [];
  if (!steps.length) return '';
  const done = steps.filter((step) => step.done).length;
  const lastDone = steps.filter((step) => step.done).pop()?.n ?? null;
  return section('steps', `Passos · ${done}/${steps.length}`, `<ol class="plan-steps">${steps.map((step) => stepRow(task, step, ui, step.n === lastDone)).join('')}</ol>`);
}

function yourTurnSection(task) {
  const current = (task.steps ?? []).find((step) => step.n === task.current);
  if (task.phase !== 'steps' || !current?.dev) return '';
  const todos = (task.devTodos ?? []).map((todo) =>
    `<li>${button(`${todo.file}:${todo.line}`, { ui: 'open-file', file: todo.file, line: todo.line })} <span>${e(todo.note)}</span></li>`);
  const list = todos.length ? `<ul class="plan-todos">${todos.join('')}</ul>` : '<p class="plan-hint">o andaime ainda não tem TODO(dev)</p>';
  return section('your-turn', 'Sua vez', `<p>${e(current.text)}</p>${list}${button('fiz', { task: 'devDone' }, { cls: 'plan-action' })}`);
}

function footer(task) {
  const mode = (id, label) => button(label, { task: 'setMode', arg: id }, { cls: `plan-link${task.mode === id ? ' on' : ''}` });
  const blockers = task.pr?.blockers ?? [];
  const ready = Boolean(task.pr?.ready);
  const reasons = blockers.length ? `<span class="plan-why">${e(blockers.join('; '))}</span>` : '';
  // Only the unreviewed steps can be skipped; a changed locked test or a pending step cannot.
  const skippable = !task.openAnyway && blockers.length > 0 && blockers.every((text) => text.endsWith('sem revisão'));
  const anyway = skippable ? button('abrir assim mesmo', { task: 'openAnyway' }) : '';
  const quick = task.quick ? '' : button('tarefa rápida', { task: 'quick' }, { title: 'sem contrato nem testes travados' });
  return `<div class="plan-foot"><span>${mode('step', 'passo a passo')} ${mode('trust', 'confiança')}</span> ${quick}
    ${button('encerrar tarefa', { task: 'endTask' })}
    <span class="plan-pr">${button('Abrir PR', { plan: 'pr' }, { disabled: !ready, cls: 'plan-action' })} ${reasons} ${anyway}</span></div>`;
}

export function renderTaskCard(task, ui = {}) {
  if (!task) return '';
  const showTests = task.phase !== 'contract';
  const body = [
    questionSection(ui),
    contractSection(task, ui),
    showTests ? testsSection(task, ui) : '',
    task.phase === 'steps' || task.phase === 'pr' ? stepsSection(task, ui) : '',
    yourTurnSection(task),
    footer(task),
  ].join('');
  const title = task.title ? ` · ${e(task.title)}` : '';
  return `<div class="plan-card task-card" data-phase="${e(task.phase)}"><div class="plan-head"><b>Tarefa #${e(task.issue)}${title}</b><span class="plan-phase">${e(PHASE_LABELS[task.phase] ?? task.phase)}</span></div>${body}</div>`;
}

const PHASE_LABELS = { contract: 'contrato', tests: 'testes', steps: 'passos', pr: 'pronta pra PR' };
