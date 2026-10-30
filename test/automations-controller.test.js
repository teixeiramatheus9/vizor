import { describe, it, expect, vi } from 'vitest';
import { createAutomationsController, CLOCK_MS } from '../src/renderer/automations/automations-controller.js';

const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const projects = { '/p/app': { name: 'app' } };

const automation = (over = {}) => ({
  id: 'a1', name: 'PRs', slug: 'prs', projectRoot: '/p/app', when: { kind: 'daily', at: '09:00' }, describe: 'todo dia às 9h', prompt: 'Resuma.',
  level: 'read', model: 'sonnet', capUsd: 1, timeoutMin: 15, missed: 'run', skillScope: 'personal', paused: false, blockedUntilConfirm: false,
  next: NOW + 3600000, last: null, running: null, queued: false, ...over,
});
const state = (list = [], over = {}) => ({ list, budget: { spent: 0.42, cap: 5, paused: false }, nextAt: null, readError: null, guardEnabled: true, ...over });

function setup({ initial = state(), apiOver = {}, visible = true } = {}) {
  const handlers = {};
  const el = { addEventListener: (type, fn) => (handlers[type] = fn) };
  const writes = { list: 0 };
  const elapsed = [];
  let listHtml = '';
  const regions = {
    top: { innerHTML: '' },
    list: { get innerHTML() { return listHtml; }, set innerHTML(value) { listHtml = value; writes.list++; elapsed.length = 0; for (const m of value.matchAll(/data-au-elapsed="(\d+)"/g)) elapsed.push({ dataset: { auElapsed: m[1] }, textContent: '' }); }, querySelectorAll: (selector) => (selector === '[data-au-elapsed]' ? elapsed : []) },
    side: { innerHTML: '' },
  };
  const clock = { now: NOW };
  const timers = [];
  const api = {
    automationsState: vi.fn(async () => initial),
    automationsSave: vi.fn(async () => ({ ok: true })),
    automationsRemove: vi.fn(async () => ({ ok: true, warnings: [] })),
    automationsRun: vi.fn(async () => ({ ok: true })),
    automationsPause: vi.fn(async () => ({ ok: true })),
    automationsConfirm: vi.fn(async () => ({ ok: true })),
    automationsCancel: vi.fn(async () => true),
    automationsHistory: vi.fn(async () => []),
    automationsReport: vi.fn(async () => 'texto'),
    automationsImprove: vi.fn(async () => ({ ok: true, text: '## Objetivo\nX' })),
    automationsSetDayCap: vi.fn(async () => ({ ok: true, cap: 8 })),
    ...apiOver,
  };
  const openReview = vi.fn();
  const notify = vi.fn();
  const controller = createAutomationsController({
    el, regions, api, projects: () => projects, openReview, notify,
    now: () => clock.now,
    setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; },
    clearTimer: (handle) => { handle.cleared = true; },
  });
  if (initial) controller.setState(initial);
  if (visible) controller.setVisible(true);
  const live = () => timers.filter((timer) => !timer.cleared);
  return { writes, elapsed, controller, regions, api, handlers, clock, timers, live, openReview, notify };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const target = (match) => ({ closest: (selector) => (selector in match ? match[selector] : null) });
const act = (action, id) => ({ '[data-au-action]': { dataset: { auAction: action, id } } });
const click = (t, match) => t.handlers.click({ target: target(match), preventDefault() {} });
const field = (name, value, extra = {}) => ({ '[data-au-field]': { dataset: { auField: name }, value, tagName: 'INPUT', type: 'text', ...extra } });

describe('automations controller', () => {
  it('draws nothing while hidden and the skeleton before the first state', () => {
    const hidden = setup({ visible: false });
    expect(hidden.regions.list.innerHTML).toBe('');
    const fresh = setup({ initial: null });
    expect(fresh.regions.list.innerHTML).toContain('skeleton');
  });

  it('draws the list, the budget and the empty state', () => {
    const t = setup({ initial: state([automation()]) });
    expect(t.regions.list.innerHTML).toContain('PRs');
    expect(t.regions.top.innerHTML).toContain('hoje: US$ 0,42 de 5,00');
    expect(setup().regions.list.innerHTML).toContain('nenhuma automação ainda');
  });

  it('reads the state when it becomes visible', async () => {
    const t = setup({ visible: false });
    t.controller.setVisible(true);
    await flush();
    expect(t.api.automationsState).toHaveBeenCalled();
  });

  describe('the running clock', () => {
    it('runs one 1 s timeout while visible and something runs, and stops when it ends', () => {
      const t = setup({ initial: state([automation({ running: { startedAt: NOW - 5000, late: false } })]) });
      expect(t.live()).toHaveLength(1);
      expect(t.live()[0].ms).toBe(CLOCK_MS);
      t.clock.now += 1000;
      const [timer] = t.live();
      timer.fn();
      expect(t.elapsed[0].textContent).toBe('6 s');
      // the fired one is spent; the next second is armed again
      expect(t.timers).toHaveLength(2);
      expect(t.timers.at(-1)).toMatchObject({ ms: CLOCK_MS, cleared: false });
      t.controller.setState(state([automation()]));
      expect(t.timers.at(-1).cleared).toBe(true);
    });

    it('a tick only rewrites the elapsed text: the list, its focus and an open delete confirmation stay', () => {
      const t = setup({ initial: state([automation({ running: { startedAt: NOW - 5000 } }), automation({ id: 'a2', name: 'Outra' })]) });
      click(t, act('delete', 'a2'));
      const writes = t.writes.list;
      const html = t.regions.list.innerHTML;
      expect(html).toContain('apagar a skill também');
      t.clock.now += 1000;
      t.timers.at(-1).fn();
      expect(t.writes.list).toBe(writes);
      expect(t.regions.list.innerHTML).toBe(html);
      expect(t.elapsed[0].textContent).toBe('6 s');
      expect(t.timers.at(-1)).toMatchObject({ ms: CLOCK_MS, cleared: false });
    });

    it('has no timer with nothing running or with the tab hidden', () => {
      expect(setup({ initial: state([automation()]) }).controller.hasTimer()).toBe(false);
      const t = setup({ initial: state([automation({ running: { startedAt: NOW } })]) });
      expect(t.controller.hasTimer()).toBe(true);
      t.controller.setVisible(false);
      expect(t.controller.hasTimer()).toBe(false);
      expect(t.live()).toHaveLength(0);
      t.controller.setState(state([automation({ running: { startedAt: NOW } })]));
      expect(t.live()).toHaveLength(0);
    });

    it('a timer that fires after the tab hid does nothing', () => {
      const t = setup({ initial: state([automation({ running: { startedAt: NOW } })]) });
      const [timer] = t.timers;
      t.controller.setVisible(false);
      const before = t.regions.list.innerHTML;
      timer.fn();
      expect(t.regions.list.innerHTML).toBe(before);
      expect(t.live()).toHaveLength(0);
    });
  });

  describe('item actions', () => {
    it('run, pause, confirm and cancel call the api and read the state again', async () => {
      const t = setup({ initial: state([automation()]) });
      click(t, act('run', 'a1'));
      expect(t.api.automationsRun).toHaveBeenCalledWith('a1');
      click(t, act('pause', 'a1'));
      expect(t.api.automationsPause).toHaveBeenCalledWith('a1', true);
      click(t, act('confirm', 'a1'));
      expect(t.api.automationsConfirm).toHaveBeenCalledWith('a1');
      click(t, act('cancel', 'a1'));
      expect(t.api.automationsCancel).toHaveBeenCalledWith('a1');
      await flush();
      expect(t.api.automationsState).toHaveBeenCalled();
    });

    it('resumes a paused one', () => {
      const t = setup({ initial: state([automation({ paused: true })]) });
      click(t, act('pause', 'a1'));
      expect(t.api.automationsPause).toHaveBeenCalledWith('a1', false);
    });

    it('shows the service error on the item', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsRun: vi.fn(async () => ({ ok: false, error: 'Ela já está rodando.' })) } });
      click(t, act('run', 'a1'));
      await flush();
      expect(t.regions.list.innerHTML).toContain('Ela já está rodando.');
    });

    it('asks before deleting, with the skill and worktree options', async () => {
      const t = setup({ initial: state([automation({ level: 'worktree' })]) });
      click(t, act('delete', 'a1'));
      expect(t.regions.list.innerHTML).toContain('apagar a skill também');
      expect(t.api.automationsRemove).not.toHaveBeenCalled();
      t.handlers.change({ target: target({ '[data-au-drop]': { dataset: { auDrop: 'skill' }, checked: true } }) });
      t.handlers.change({ target: target({ '[data-au-drop]': { dataset: { auDrop: 'worktree' }, checked: true } }) });
      click(t, act('delete-confirm', 'a1'));
      await flush();
      expect(t.api.automationsRemove).toHaveBeenCalledWith('a1', { removeSkill: true, removeWorktree: true });
    });

    it('"Não" backs out of the delete and nothing is removed', () => {
      const t = setup({ initial: state([automation()]) });
      click(t, act('delete', 'a1'));
      click(t, act('delete-cancel', 'a1'));
      expect(t.regions.list.innerHTML).not.toContain('apagar a skill também');
      expect(t.api.automationsRemove).not.toHaveBeenCalled();
    });

    it('tells the user about the delete warnings', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsRemove: vi.fn(async () => ({ ok: true, warnings: ['a skill está no git'] })) } });
      click(t, act('delete', 'a1'));
      click(t, act('delete-confirm', 'a1'));
      await flush();
      expect(t.notify).toHaveBeenCalledWith('a skill está no git');
    });
  });

  describe('the form', () => {
    it('opens blank on "nova automação" and fills from "editar"', () => {
      const t = setup({ initial: state([automation({ name: 'Antiga' })]) });
      click(t, act('new'));
      expect(t.regions.side.innerHTML).toContain('Nova automação');
      click(t, act('edit', 'a1'));
      expect(t.regions.side.innerHTML).toContain('Editar automação');
      expect(t.regions.side.innerHTML).toContain('value="Antiga"');
    });

    it('typing updates the form without redrawing it, and a state push leaves it alone', () => {
      const t = setup({ initial: state([automation()]) });
      click(t, act('new'));
      const before = t.regions.side.innerHTML;
      t.handlers.input({ target: target(field('name', 'Minha')) });
      t.handlers.input({ target: target(field('prompt', 'Faça', { tagName: 'TEXTAREA' })) });
      expect(t.regions.side.innerHTML).toBe(before);
      t.controller.setState(state([automation()]));
      expect(t.regions.side.innerHTML).toBe(before);
    });

    it('saves a valid form and closes it, then reads the state', async () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      t.handlers.input({ target: target(field('name', 'Minha')) });
      t.handlers.input({ target: target(field('prompt', 'Faça', { tagName: 'TEXTAREA' })) });
      click(t, act('save'));
      await flush();
      expect(t.api.automationsSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Minha', prompt: 'Faça', projectRoot: '/p/app', level: 'read', model: 'sonnet', when: { kind: 'daily', at: '09:00' } }));
      expect(t.regions.side.innerHTML).not.toContain('Nova automação');
    });

    it('does not call save on an invalid form', async () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      click(t, act('save'));
      await flush();
      expect(t.api.automationsSave).not.toHaveBeenCalled();
    });

    it('does not save while the file is unreadable', async () => {
      const t = setup({ initial: state([], { readError: 'não deu pra ler as automações' }) });
      expect(t.regions.top.innerHTML).toContain('não deu pra ler as automações');
      click(t, act('new'));
      t.handlers.input({ target: target(field('name', 'M')) });
      t.handlers.input({ target: target(field('prompt', 'p', { tagName: 'TEXTAREA' })) });
      click(t, act('save'));
      await flush();
      expect(t.api.automationsSave).not.toHaveBeenCalled();
    });

    it('keeps the form open and shows the error when main refuses', async () => {
      const t = setup({ initial: state([]), apiOver: { automationsSave: vi.fn(async () => ({ ok: false, error: 'A trava está desligada' })) } });
      click(t, act('new'));
      t.handlers.input({ target: target(field('name', 'M')) });
      t.handlers.input({ target: target(field('prompt', 'p', { tagName: 'TEXTAREA' })) });
      click(t, act('save'));
      await flush();
      expect(t.regions.side.innerHTML).toContain('A trava está desligada');
    });

    it('a preset fills the "quando" fields', () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      click(t, { '[data-au-preset]': { dataset: { auPreset: '0' } } });
      expect(t.regions.side.innerHTML).toContain('value="30"');
      click(t, { '[data-au-preset]': { dataset: { auPreset: '2' } } });
      expect(t.regions.side.innerHTML).toMatch(/<option value="weekdays" selected>/);
    });

    it('a select redraws the form (the level changes the hints)', () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      t.handlers.change({ target: target(field('skillScope', 'project', { tagName: 'SELECT' })) });
      expect(t.regions.side.innerHTML).toContain('vai pro repositório se você commitar');
    });

    it('toggles the chosen days', () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      t.handlers.change({ target: target(field('whenKind', 'days', { tagName: 'SELECT' })) });
      t.handlers.change({ target: target({ '[data-au-day]': { dataset: { auDay: '1' }, checked: false } }) });
      t.handlers.change({ target: target({ '[data-au-day]': { dataset: { auDay: '6' }, checked: true } }) });
      t.handlers.input({ target: target(field('name', 'Dias')) });
      t.handlers.input({ target: target(field('prompt', 'p', { tagName: 'TEXTAREA' })) });
      click(t, act('save'));
      return flush().then(() => {
        expect(t.api.automationsSave).toHaveBeenCalledWith(expect.objectContaining({ when: { kind: 'days', days: [2, 3, 4, 5, 6], at: '09:00' } }));
      });
    });

    it('"melhorar o pedido" puts the result in the prompt, editable, and can go back', async () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      t.handlers.input({ target: target(field('prompt', 'meu texto', { tagName: 'TEXTAREA' })) });
      click(t, act('improve'));
      expect(t.regions.side.innerHTML).toContain('melhorando…');
      await flush();
      expect(t.api.automationsImprove).toHaveBeenCalledWith('meu texto');
      expect(t.api.automationsSave).not.toHaveBeenCalled();
      expect(t.regions.side.innerHTML).toContain('## Objetivo');
      expect(t.regions.side.innerHTML).toContain('voltar ao meu texto');
      click(t, act('undo-improve'));
      expect(t.regions.side.innerHTML).toContain('meu texto');
      expect(t.regions.side.innerHTML).not.toContain('voltar ao meu texto');
    });

    it('shows why the improvement failed and keeps the text', async () => {
      const t = setup({ initial: state([]), apiOver: { automationsImprove: vi.fn(async () => ({ ok: false, error: 'O teto de tokens do gerente acabou hoje' })) } });
      click(t, act('new'));
      t.handlers.input({ target: target(field('prompt', 'meu texto', { tagName: 'TEXTAREA' })) });
      click(t, act('improve'));
      await flush();
      expect(t.regions.side.innerHTML).toContain('O teto de tokens do gerente acabou hoje');
      expect(t.regions.side.innerHTML).toContain('meu texto');
    });

    it('does not call the gerente for an empty request', async () => {
      const t = setup({ initial: state([]) });
      click(t, act('new'));
      click(t, act('improve'));
      await flush();
      expect(t.api.automationsImprove).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    const runs = [
      { status: 'ok', at: new Date(NOW - 60000).toISOString(), report: '20261027-0959.md', costUsd: 0.1, durationMs: 1000, branch: 'auto/prs/x' },
      { status: 'failed', at: new Date(NOW - 3600000).toISOString(), report: '20261027-0900.md', costUsd: 0.1, durationMs: 1000 },
    ];
    it('lists the runs and opens the newest report', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => runs), automationsReport: vi.fn(async () => '# Relatório\n\ntudo bem') } });
      click(t, act('history', 'a1'));
      expect(t.regions.side.innerHTML).toContain('skeleton');
      await flush();
      expect(t.api.automationsReport).toHaveBeenCalledWith('a1', '20261027-0959.md');
      expect(t.regions.side.innerHTML).toContain('<h1 class="md-h">Relatório</h1>');
      expect(t.regions.side.innerHTML).toContain('falhou');
    });

    it('opens another report on click', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => runs) } });
      click(t, act('history', 'a1'));
      await flush();
      click(t, { '[data-au-run]': { dataset: { auRun: '20261027-0900.md', id: 'a1' } } });
      await flush();
      expect(t.api.automationsReport).toHaveBeenLastCalledWith('a1', '20261027-0900.md');
    });

    it('a report read that finishes after the panel closed is dropped', async () => {
      let release;
      const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => runs), automationsReport: vi.fn(() => new Promise((resolve) => { release = resolve; })) } });
      click(t, act('history', 'a1'));
      await flush();
      click(t, act('close-side'));
      release('# tarde');
      await flush();
      expect(t.regions.side.innerHTML).not.toContain('tarde');
    });

    it('"abrir na revisão" opens the worktree of the second level', async () => {
      const t = setup({ initial: state([automation({ level: 'worktree' })]), apiOver: { automationsHistory: vi.fn(async () => runs) } });
      click(t, act('history', 'a1'));
      await flush();
      click(t, act('review', 'a1'));
      expect(t.openReview).toHaveBeenCalledWith('/p/app-auto-prs');
    });

    it('reads the history again when a run finishes', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => runs) } });
      click(t, act('history', 'a1'));
      await flush();
      t.api.automationsHistory.mockClear();
      t.controller.setState(state([automation({ last: { report: 'novo.md', status: 'ok' } })]));
      await flush();
      expect(t.api.automationsHistory).toHaveBeenCalledWith('a1');
    });

    it('closes the panel when the automação is gone', async () => {
      const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => runs) } });
      click(t, act('history', 'a1'));
      await flush();
      t.controller.setState(state([]));
      expect(t.regions.side.innerHTML).toContain('ou crie uma nova');
      expect(t.regions.side.innerHTML).not.toContain('Fechar');
      expect(t.regions.side.innerHTML).not.toContain('PRs');
    });
  });

  describe('the day cap', () => {
    it('raises it from the tab and shows the answer', async () => {
      const t = setup({ initial: state([]) });
      click(t, act('cap-edit'));
      expect(t.regions.top.innerHTML).toContain('data-au-cap-input');
      t.handlers.submit({ target: target({ '[data-au-cap]': { querySelector: () => ({ value: '8,5' }) } }), preventDefault() {} });
      await flush();
      expect(t.api.automationsSetDayCap).toHaveBeenCalledWith(8.5);
      expect(t.regions.top.innerHTML).not.toContain('data-au-cap-input');
    });

    it('shows the refusal and keeps the field open', async () => {
      const t = setup({ initial: state([]), apiOver: { automationsSetDayCap: vi.fn(async () => ({ ok: false, error: 'O teto do dia deve ficar entre US$ 0,50 e US$ 100.' })) } });
      click(t, act('cap-edit'));
      t.handlers.submit({ target: target({ '[data-au-cap]': { querySelector: () => ({ value: '500' }) } }), preventDefault() {} });
      await flush();
      expect(t.regions.top.innerHTML).toContain('entre US$ 0,50 e US$ 100');
      expect(t.regions.top.innerHTML).toContain('data-au-cap-input');
    });

    it('cancel closes the field; Escape too', () => {
      const t = setup({ initial: state([]) });
      click(t, act('cap-edit'));
      click(t, act('cap-cancel'));
      expect(t.regions.top.innerHTML).not.toContain('data-au-cap-input');
      click(t, act('cap-edit'));
      const stop = vi.fn();
      t.handlers.keydown({ key: 'Escape', stopPropagation: stop });
      expect(stop).toHaveBeenCalled();
      expect(t.regions.top.innerHTML).not.toContain('data-au-cap-input');
    });
  });

  it('the history of an automação opens from outside (a kanban card)', async () => {
    const t = setup({ initial: state([automation()]), apiOver: { automationsHistory: vi.fn(async () => []) } });
    t.controller.showHistory('a1');
    await flush();
    expect(t.api.automationsHistory).toHaveBeenCalledWith('a1');
    expect(t.regions.side.innerHTML).toContain('ainda não rodou');
  });

  it('Ctrl+K hooks: startNew opens the form and runNow runs by id', () => {
    const t = setup({ initial: state([automation()]) });
    t.controller.startNew();
    expect(t.regions.side.innerHTML).toContain('Nova automação');
    t.controller.runNow('a1');
    expect(t.api.automationsRun).toHaveBeenCalledWith('a1');
  });
});
