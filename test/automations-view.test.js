import { describe, it, expect } from 'vitest';
import {
  EMPTY_TEXT, GUARD_OFF_REASON, LEVELS, PRESETS, agoLabel, blankForm, elapsedLabel, formFromAutomation, money, nextLabel,
  renderForm, renderHistory, renderList, renderSideEmpty, renderTop, runStatusLabel, stateOf, validateForm, worktreeOf,
} from '../src/renderer/automations/automations-view.js';

const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const MIN = 60000;
const EVIL = '<img src=x onerror=alert(1)>"\'&';
const projects = { '/p/app': { name: 'app', uri: null, accent: '#abc' }, '/p/lib': { name: 'lib' } };

const automation = (over = {}) => ({
  id: 'a1', name: 'PRs da manhã', slug: 'prs', projectRoot: '/p/app', when: { kind: 'daily', at: '09:00' }, describe: 'todo dia às 9h',
  level: 'read', model: 'sonnet', capUsd: 1, timeoutMin: 15, missed: 'run', skillScope: 'personal', paused: false, blockedUntilConfirm: false,
  next: NOW + 4 * 3600000, last: null, running: null, queued: false, prompt: 'Resuma.', ...over,
});

describe('labels', () => {
  it('formats money, ago, next and elapsed in pt-BR', () => {
    expect(money(0.42)).toBe('US$ 0,42');
    expect(agoLabel(NOW - 5 * MIN, NOW)).toBe('há 5 min');
    expect(agoLabel(NOW - 30000, NOW)).toBe('agora');
    expect(nextLabel(new Date(2026, 9, 27, 14, 0).getTime(), NOW)).toBe('14:00');
    expect(nextLabel(new Date(2026, 9, 28, 9, 5).getTime(), NOW)).toBe('amanhã 09:05');
    expect(nextLabel(new Date(2026, 10, 3, 9, 5).getTime(), NOW)).toBe('03/11 09:05');
    expect(nextLabel(null, NOW)).toBeNull();
    expect(elapsedLabel(NOW - 185000, NOW)).toBe('3 min 05 s');
    expect(elapsedLabel(NOW - 7000, NOW)).toBe('7 s');
  });

  it('names each history status in pt-BR', () => {
    expect(runStatusLabel({ status: 'ok' })).toBe('ok');
    expect(runStatusLabel({ status: 'failed' })).toBe('falhou');
    expect(runStatusLabel({ status: 'over-cap' })).toBe('passou do teto');
    expect(runStatusLabel({ status: 'timeout' })).toBe('passou do tempo');
    expect(runStatusLabel({ status: 'cancelled' })).toBe('cancelada');
    expect(runStatusLabel({ status: 'blocked', reason: 'A trava barrou 2 passo(s).' })).toBe('ok, com passos barrados');
    expect(runStatusLabel({ status: 'blocked', reason: 'O claude terminou com erro.' })).toBe('barrada pela trava');
    expect(runStatusLabel({ status: 'ok', late: true })).toBe('ok (atrasada)');
    expect(runStatusLabel({ status: 'over-cap', late: true })).toBe('passou do teto (atrasada)');
  });

  it('finds the worktree of the second level next to the repo', () => {
    expect(worktreeOf({ projectRoot: '/p/app/', slug: 'prs' })).toBe('/p/app-auto-prs');
  });
});

describe('list', () => {
  it('shows the empty state and the skeleton', () => {
    expect(renderList([], {})).toContain(EMPTY_TEXT);
    expect(renderList([], { loading: true })).toContain('skeleton');
  });

  it('escapes every field that came from an automação or a project', () => {
    const html = renderList([automation({ name: EVIL, describe: EVIL, projectRoot: '/p/x', last: { status: 'failed', at: new Date(NOW - MIN).toISOString(), late: false } })], { projects: { '/p/x': { name: EVIL, uri: `data:image/png;base64,${EVIL}`, accent: EVIL } }, now: NOW, ui: { error: { id: 'a1', text: EVIL } } });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=alert(1)>"');
    expect(html).toContain('&lt;img src=x');
  });

  it('draws each state', () => {
    const draw = (over) => renderList([automation(over)], { projects, now: NOW });
    expect(draw({ running: { startedAt: NOW - 65000, late: false } })).toContain('rodando há 1 min 05 s');
    expect(draw({ running: { startedAt: NOW - 5000, late: true } })).toContain('atrasada');
    expect(draw({ running: { startedAt: NOW - 5000 } })).toContain('data-au-action="cancel"');
    expect(draw({ queued: true })).toContain('na fila');
    expect(draw({ paused: true })).toContain('pausada');
    expect(draw({ paused: true })).toContain('Retomar');
    const blocked = draw({ blockedUntilConfirm: true });
    expect(blocked).toContain('bloqueada');
    expect(blocked).toContain('data-au-action="confirm"');
    expect(blocked).toMatch(/data-au-action="run"[^>]*disabled/);
    const idle = draw({ last: { status: 'ok', at: new Date(NOW - 5 * MIN).toISOString() } });
    expect(idle).toContain('✓ ok há 5 min');
    expect(idle).toContain('todo dia às 9h');
    expect(idle).toContain('próxima: 14:00');
    expect(idle).toContain('Pausar');
    expect(draw({ last: { status: 'failed', at: new Date(NOW).toISOString() } })).toContain('✗ falhou');
    expect(draw({})).toContain('nunca rodou');
  });

  it('priorities: running beats queued beats blocked beats paused', () => {
    expect(stateOf(automation({ running: { startedAt: 1 }, paused: true, blockedUntilConfirm: true })).id).toBe('running');
    expect(stateOf(automation({ queued: true, paused: true })).id).toBe('queued');
    expect(stateOf(automation({ blockedUntilConfirm: true, paused: true })).id).toBe('blocked');
    expect(stateOf(automation({ paused: true })).id).toBe('paused');
    expect(stateOf(automation()).id).toBe('idle');
  });

  it('shows the level badge and the delete confirmation with its options', () => {
    const a = automation({ level: 'worktree' });
    const html = renderList([a], { projects, now: NOW, ui: { deleting: 'a1' } });
    expect(html).toContain('level-worktree');
    expect(html).toContain('apagar a skill também');
    expect(html).toContain('remover a worktree');
    expect(renderList([automation()], { projects, now: NOW, ui: { deleting: 'a1' } })).not.toContain('remover a worktree');
  });

  it('disables delete when the file could not be read', () => {
    expect(renderList([automation()], { projects, now: NOW, readError: 'x' })).toMatch(/data-au-action="delete"[^>]*disabled/);
  });
});

describe('top', () => {
  it('shows the day budget with the raise-cap link, paused included', () => {
    const html = renderTop({ budget: { spent: 0.42, cap: 5, paused: false } });
    expect(html).toContain('hoje: US$ 0,42 de 5,00');
    expect(html).toContain('subir teto');
    expect(html).toContain('nova automação');
    expect(renderTop({ budget: { spent: 5, cap: 5, paused: true } })).toContain('pausadas');
  });

  it('opens the cap field and shows its error, and the read error', () => {
    const html = renderTop({ budget: { spent: 1, cap: 5, paused: false }, readError: EVIL, ui: { capEditing: true, capError: EVIL } });
    expect(html).toContain('data-au-cap-input');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('role="alert"');
  });
});

describe('form validation', () => {
  const ok = () => ({ ...blankForm(projects), name: 'Nome', prompt: 'Faça.' });
  it('accepts a complete form and builds the payload', () => {
    const { errors, payload } = validateForm(ok(), { projects });
    expect(errors).toEqual({});
    expect(payload).toMatchObject({ name: 'Nome', projectRoot: '/p/app', when: { kind: 'daily', at: '09:00' }, level: 'read', model: 'sonnet', capUsd: 1, timeoutMin: 15, missed: 'run', skillScope: 'personal' });
    expect(payload.id).toBeUndefined();
  });

  it('flags the empty name, prompt and project, as it is typed', () => {
    const { errors, payload } = validateForm({ ...blankForm({}), projectRoot: '' }, { projects: {} });
    expect(payload).toBeNull();
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(['name', 'prompt', 'projectRoot']));
  });

  it('enforces the 15 minute minimum and the hours unit', () => {
    expect(validateForm({ ...ok(), whenKind: 'every', everyN: '10', everyUnit: 'min' }, { projects }).errors.when).toMatch(/mínimo/);
    expect(validateForm({ ...ok(), whenKind: 'every', everyN: '15', everyUnit: 'min' }, { projects }).errors.when).toBeUndefined();
    expect(validateForm({ ...ok(), whenKind: 'every', everyN: '2', everyUnit: 'h' }, { projects }).payload.when).toEqual({ kind: 'every', minutes: 120 });
    expect(validateForm({ ...ok(), whenKind: 'every', everyN: 'x' }, { projects }).errors.when).toBeTruthy();
  });

  it('validates the time and the chosen days', () => {
    expect(validateForm({ ...ok(), whenKind: 'daily', at: '' }, { projects }).errors.when).toBeTruthy();
    expect(validateForm({ ...ok(), whenKind: 'days', days: [], at: '09:00' }, { projects }).errors.when).toMatch(/dia/);
    expect(validateForm({ ...ok(), whenKind: 'days', days: [1, 3], at: '07:30' }, { projects }).payload.when).toEqual({ kind: 'days', days: [1, 3], at: '07:30' });
  });

  it('validates the caps, accepting a decimal comma', () => {
    expect(validateForm({ ...ok(), capUsd: '0,5' }, { projects }).payload.capUsd).toBe(0.5);
    expect(validateForm({ ...ok(), capUsd: '0,01' }, { projects }).errors.capUsd).toBeTruthy();
    expect(validateForm({ ...ok(), capUsd: '21' }, { projects }).errors.capUsd).toBeTruthy();
    expect(validateForm({ ...ok(), capUsd: '' }, { projects }).errors.capUsd).toBeTruthy();
    expect(validateForm({ ...ok(), timeoutMin: '0' }, { projects }).errors.timeoutMin).toBeTruthy();
    expect(validateForm({ ...ok(), timeoutMin: '61' }, { projects }).errors.timeoutMin).toBeTruthy();
    expect(validateForm({ ...ok(), timeoutMin: '1,5' }, { projects }).errors.timeoutMin).toBeTruthy();
  });

  it('refuses the editing levels while the guard is off', () => {
    expect(validateForm({ ...ok(), level: 'worktree' }, { projects, guardEnabled: false }).errors.level).toBe(GUARD_OFF_REASON);
    expect(validateForm({ ...ok(), level: 'read' }, { projects, guardEnabled: false }).errors.level).toBeUndefined();
  });

  it('keeps the id when editing and round-trips a saved automação', () => {
    const a = automation({ when: { kind: 'every', minutes: 120 }, capUsd: 2.5 });
    const form = formFromAutomation(a);
    expect(form).toMatchObject({ id: 'a1', whenKind: 'every', everyN: '2', everyUnit: 'h', capUsd: '2.5' });
    const { payload } = validateForm(form, { projects });
    expect(payload).toMatchObject({ id: 'a1', when: { kind: 'every', minutes: 120 }, capUsd: 2.5 });
    expect(formFromAutomation(automation({ when: { kind: 'every', minutes: 30 } }))).toMatchObject({ everyN: '30', everyUnit: 'min' });
    expect(formFromAutomation(automation({ when: { kind: 'days', days: [2, 4], at: '08:15' } }))).toMatchObject({ whenKind: 'days', days: [2, 4], at: '08:15' });
  });

  it('every preset is a valid schedule', () => {
    for (const preset of PRESETS) expect(validateForm({ ...ok(), ...preset.fields }, { projects }).errors.when).toBeUndefined();
    expect(PRESETS.map((preset) => preset.label)).toEqual(['a cada 30 min', 'todo dia às 9h', 'dias úteis às 9h']);
  });
});

describe('form html', () => {
  it('explains each level in one line, with the publish warning on the third', () => {
    const html = renderForm(blankForm(projects), { projects });
    for (const level of LEVELS) expect(html).toContain(level.label);
    expect(html).toContain('pode publicar no GitHub (comentar, abrir issue/PR); nunca push nem merge');
    expect(html).toContain('data-au-preset="2"');
  });

  it('with the guard off only the reading level can be picked, and says why', () => {
    const html = renderForm(blankForm(projects), { projects, guardEnabled: false });
    expect(html).toMatch(/value="worktree"[^>]*disabled/);
    expect(html).toMatch(/value="project"[^>]*disabled/);
    expect(html).not.toMatch(/value="read"[^>]*disabled/);
    expect(html).toContain(GUARD_OFF_REASON);
  });

  it('warns about the project skill only when it is the chosen scope', () => {
    expect(renderForm({ ...blankForm(projects), skillScope: 'project' }, { projects })).toContain('vai pro repositório se você commitar');
    expect(renderForm(blankForm(projects), { projects })).not.toContain('vai pro repositório');
  });

  it('offers haiku, sonnet and opus with sonnet by default', () => {
    const html = renderForm(blankForm(projects), { projects });
    expect(html).toContain('<option value="sonnet" selected>');
    expect(html).toContain('value="haiku"');
    expect(html).toContain('value="opus"');
  });

  it('shows the improved request as editable text with a way back', () => {
    const form = { ...blankForm(projects), prompt: '## Objetivo', original: 'meu texto' };
    const html = renderForm(form, { projects });
    expect(html).toContain('voltar ao meu texto');
    expect(html).toContain('confira e edite antes de salvar');
    expect(html).toContain('<textarea');
    expect(renderForm(blankForm(projects), { projects, ui: { improving: true } })).toContain('melhorando…');
  });

  it('escapes what is typed and disables save on errors or a read error', () => {
    const html = renderForm({ ...blankForm(projects), name: EVIL, prompt: EVIL }, { projects, ui: { saveError: EVIL, improveError: EVIL } });
    expect(html).not.toContain('<img src=x');
    expect(renderForm(blankForm(projects), { projects })).toMatch(/data-au-action="save" disabled/);
    expect(renderForm({ ...blankForm(projects), name: 'n', prompt: 'p' }, { projects })).not.toMatch(/data-au-action="save" disabled/);
    expect(renderForm({ ...blankForm(projects), name: 'n', prompt: 'p' }, { projects, readError: 'x' })).toMatch(/data-au-action="save" disabled/);
  });

  it('shows the day checkboxes only for the chosen-days kind', () => {
    expect(renderForm({ ...blankForm(projects), whenKind: 'days', days: [1] }, { projects })).toContain('data-au-day="6"');
    expect(renderForm(blankForm(projects), { projects })).not.toContain('data-au-day');
  });
});

describe('history', () => {
  const runs = [
    { status: 'ok', at: new Date(NOW - 3 * MIN).toISOString(), report: '20261027-0957.md', costUsd: 0.31, durationMs: 42000, late: true, branch: 'auto/prs/x' },
    { status: 'over-cap', at: new Date(NOW - 99 * MIN).toISOString(), report: '20261027-0821.md', costUsd: 1, durationMs: 9000 },
  ];
  it('lists the runs and renders the report as safe markdown', () => {
    const html = renderHistory({ automation: automation(), runs, report: { file: '20261027-0957.md', text: `# T\n\n${EVIL}` }, now: NOW });
    expect(html).toContain('ok (atrasada)');
    expect(html).toContain('passou do teto');
    expect(html).toContain('US$ 0,31 · 42 s');
    expect(html).toContain('<h1 class="md-h">T</h1>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('abrir na revisão');
  });
  it('shows "abrir na revisão" for the worktree level when the run has a branch', () => {
    const html = renderHistory({ automation: automation({ level: 'worktree' }), runs, report: { file: '20261027-0957.md', text: 'x' }, now: NOW });
    expect(html).toContain('abrir na revisão');
    expect(renderHistory({ automation: automation({ level: 'worktree' }), runs, report: { file: '20261027-0821.md', text: 'x' }, now: NOW })).not.toContain('abrir na revisão');
  });
  it('handles loading, empty and unreadable report', () => {
    expect(renderHistory({ automation: automation(), runs: null })).toContain('skeleton');
    expect(renderHistory({ automation: automation(), runs: [] })).toContain('ainda não rodou');
    expect(renderHistory({ automation: automation(), runs, report: { file: runs[0].report, text: null } })).toContain('não consegui ler');
    expect(renderHistory({ automation: automation(), runs })).toContain('escolha uma execução');
    expect(renderSideEmpty()).toContain('Histórico');
  });
  it('escapes the automação name and branch', () => {
    const html = renderHistory({ automation: automation({ name: EVIL, level: 'worktree' }), runs: [{ ...runs[0], branch: EVIL }], report: { file: runs[0].report, text: 'x' }, now: NOW });
    expect(html).not.toContain('<img src=x');
  });
});
