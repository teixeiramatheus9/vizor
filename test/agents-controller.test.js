import { describe, it, expect, vi } from 'vitest';
import { createAgentsController } from '../src/renderer/agents/agents-controller.js';

const NOW = 1_000_000_000;
const MIN = 60000;

function setup(overrides = {}) {
  const listeners = {};
  const el = {
    innerHTML: '',
    addEventListener: (type, fn) => (listeners[type] = fn),
    querySelector: () => null,
  };
  const api = {
    agentsSeen: vi.fn(),
    agentsDismiss: vi.fn(),
    agentsInterrupt: vi.fn(async () => 'interrupted'),
    agentsAnswer: vi.fn(async () => 'sent'),
    planAction: vi.fn(),
    answerGuard: vi.fn(),
    focusOutside: vi.fn(),
  };
  const timers = [];
  const clock = { now: NOW };
  const controller = createAgentsController({
    el,
    api,
    openSession: vi.fn(),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => (handle.cleared = true),
    reducedMotion: () => true,
    ...overrides,
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  return { el, api, listeners, controller, timers, live, clock, openSession: undefined };
}

const session = (over = {}) => ({
  id: 's1', status: 'working', needsPermission: false, question: null, seenAt: 0, updatedAt: NOW - MIN, failedAt: null,
  adopted: false, alias: null, title: 'Tarefa', projectName: 'a', cwd: '/p/a', ptyId: 'pty-1', term: { VIZOR_PTY_ID: 'pty-1' },
  project: { root: '/p/a', branch: 'main' }, ...over,
});

// A target whose closest() resolves the selectors the controller asks about.
const target = (match) => ({ closest: (selector) => (selector in match ? match[selector] : null) });
const click = (listeners, match) => listeners.click({ target: target(match) });
const actionButton = (action, id) => ({ '[data-action]': { dataset: { action, cardId: id } } });

describe('agents controller', () => {
  it('renders nothing while hidden and draws on show', () => {
    const { el, controller } = setup();
    controller.setState({ sessions: [session()] });
    expect(el.innerHTML).toBe('');
    controller.setVisible(true);
    expect(el.innerHTML).toContain('kb-board');
    expect(el.innerHTML).toContain('Tarefa');
  });

  it('only keeps a timer while visible, at the next 30 min cut', () => {
    const { controller, live } = setup();
    controller.setState({ sessions: [session({ status: 'done', updatedAt: NOW - 10 * MIN })] });
    expect(live()).toHaveLength(0);
    controller.setVisible(true);
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(20 * MIN + 50);
    controller.setVisible(false);
    expect(live()).toHaveLength(0);
    controller.setState({ sessions: [session({ status: 'done', updatedAt: NOW - 10 * MIN })] });
    expect(live()).toHaveLength(0);
  });

  it('moves a done card to idle when the timer fires', () => {
    const { el, controller, live, clock } = setup();
    controller.setState({ sessions: [session({ status: 'done', updatedAt: NOW - 10 * MIN })] });
    controller.setVisible(true);
    expect(el.innerHTML).toMatch(/data-card="s1" data-column="done"/);
    clock.now += 21 * MIN;
    live()[0].fn();
    expect(el.innerHTML).toMatch(/data-card="s1" data-column="idle"/);
  });

  it('schedules nothing when no card is about to change column', () => {
    const { controller, live } = setup();
    controller.setState({ sessions: [session()] });
    controller.setVisible(true);
    expect(live()).toHaveLength(0);
  });

  it('clicking a card marks it seen and opens it in the Workspace', () => {
    const openSession = vi.fn();
    const { api, listeners, controller } = setup({ openSession });
    controller.setState({ sessions: [session()] });
    controller.setVisible(true);
    click(listeners, { '[data-card]': { dataset: { card: 's1' } } });
    expect(api.agentsSeen).toHaveBeenCalledWith('s1');
    expect(openSession).toHaveBeenCalledWith('s1');
  });

  it('uses the terminal focus for a chat outside the Vizor', () => {
    const openSession = vi.fn();
    const { api, listeners, controller } = setup({ openSession });
    controller.setState({ sessions: [session({ ptyId: null, term: null })] });
    controller.setVisible(true);
    click(listeners, actionButton('focus', 's1'));
    expect(api.focusOutside).toHaveBeenCalledWith('s1');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('does nothing when a failed tombstone is clicked', () => {
    const { api, listeners, controller } = setup();
    controller.setState({ sessions: [session({ status: 'failed', failedAt: NOW - MIN })] });
    controller.setVisible(true);
    click(listeners, { '[data-card]': { dataset: { card: 's1' } } });
    expect(api.agentsSeen).not.toHaveBeenCalled();
    click(listeners, actionButton('dismiss', 's1'));
    expect(api.agentsDismiss).toHaveBeenCalledWith('s1');
  });

  it('asks before interrupting, and only then interrupts', () => {
    const { el, api, listeners, controller } = setup();
    controller.setState({ sessions: [session()] });
    controller.setVisible(true);
    click(listeners, actionButton('interrupt', 's1'));
    expect(api.agentsInterrupt).not.toHaveBeenCalled();
    expect(el.innerHTML).toContain('Interromper?');
    click(listeners, actionButton('cancel', 's1'));
    expect(el.innerHTML).not.toContain('Interromper?');
    click(listeners, actionButton('interrupt', 's1'));
    click(listeners, actionButton('interrupt-confirm', 's1'));
    expect(api.agentsInterrupt).toHaveBeenCalledWith('s1');
  });

  it('says so when the interrupt is refused', async () => {
    const { el, api, listeners, controller } = setup();
    api.agentsInterrupt.mockResolvedValue('failed');
    controller.setState({ sessions: [session()] });
    controller.setVisible(true);
    click(listeners, actionButton('interrupt', 's1'));
    click(listeners, actionButton('interrupt-confirm', 's1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(el.innerHTML).toContain('não deu pra interromper');
  });

  it('answers through the reply box and closes it when sent', async () => {
    const { el, api, listeners, controller } = setup();
    controller.setState({ sessions: [session({ status: 'waiting', question: 'Qual?' })] });
    controller.setVisible(true);
    click(listeners, actionButton('answer', 's1'));
    expect(el.innerHTML).toContain('kb-reply-input');
    const form = { dataset: { cardId: 's1' }, querySelector: () => ({ value: ' sim ' }) };
    await listeners.submit({ preventDefault() {}, target: { closest: () => form } });
    expect(api.agentsAnswer).toHaveBeenCalledWith('s1', 'sim');
    expect(el.innerHTML).not.toContain('kb-reply-input');
  });

  it('keeps the reply box open with an error when the delivery fails', async () => {
    const { el, api, listeners, controller } = setup();
    api.agentsAnswer.mockResolvedValue('failed');
    controller.setState({ sessions: [session({ status: 'waiting', question: 'Qual?' })] });
    controller.setVisible(true);
    click(listeners, actionButton('answer', 's1'));
    const form = { dataset: { cardId: 's1' }, querySelector: () => ({ value: 'sim' }) };
    await listeners.submit({ preventDefault() {}, target: { closest: () => form } });
    expect(el.innerHTML).toContain('não consegui enviar');
  });

  it('approves an unapproved plan from the card, and answers the guard', () => {
    const { el, api, listeners, controller } = setup();
    controller.setState({
      sessions: [session({ status: 'waiting', question: 'ok?' })],
      plans: { s1: { steps: [{ text: 'a', done: false }], approved: false } },
      guardAsks: [{ id: 'g1', sessionId: 's1', summary: 'rm x', ruleSource: 'r', cwd: '/p/a', tool: 'Bash' }],
    });
    controller.setVisible(true);
    expect(el.innerHTML).toContain('data-action="approve"');
    expect(el.innerHTML).toContain('data-guard-id="g1"');
    click(listeners, actionButton('approve', 's1'));
    expect(api.planAction).toHaveBeenCalledWith('s1', 'approve');
    click(listeners, { '[data-guard-choice]': { dataset: { guardId: 'g1', guardChoice: 'liberar' }, closest: () => null } });
    expect(api.answerGuard).toHaveBeenCalledWith('g1', 'liberar');
  });

  it('marks a finished chat seen once per Stop when looked at', () => {
    const { api, controller } = setup();
    controller.setState({ sessions: [session({ status: 'done' })] });
    controller.lookingAt('s1');
    controller.lookingAt('s1');
    expect(api.agentsSeen).toHaveBeenCalledTimes(1);
    controller.lookingAt('nope');
    expect(api.agentsSeen).toHaveBeenCalledTimes(1);
    api.agentsSeen.mockClear();
    controller.setState({ sessions: [session({ status: 'working' })] });
    controller.lookingAt('s1');
    expect(api.agentsSeen).not.toHaveBeenCalled();
  });

  it('marks a finished chat seen after its idle Notification too, once per Stop', () => {
    const { api, controller } = setup();
    const stop = NOW - 2 * MIN;
    controller.setState({ sessions: [session({ status: 'waiting', stoppedAt: stop, updatedAt: stop + MIN })] });
    controller.lookingAt('s1');
    expect(api.agentsSeen).toHaveBeenCalledTimes(1);
    controller.setState({ sessions: [session({ status: 'done', stoppedAt: stop, updatedAt: stop })] });
    controller.lookingAt('s1');
    expect(api.agentsSeen).toHaveBeenCalledTimes(1);
  });

  it('does not count the idle Notification after a Stop as waiting', () => {
    const { controller } = setup();
    controller.setState({ sessions: [session({ status: 'waiting', stoppedAt: NOW - 2 * MIN, updatedAt: NOW - MIN })] });
    expect(controller.counts()).toEqual({ working: 0, waiting: 0 });
  });

  it('counts the cards waiting on the user, hidden or not', () => {
    const { controller } = setup();
    controller.setState({ sessions: [session({ status: 'waiting', question: 'q' }), session({ id: 's2' })] });
    expect(controller.waitingCount()).toBe(1);
  });

  it('filters by project and by "needs me"', () => {
    const { el, listeners, controller } = setup({ projects: () => ({ '/p/a': { name: 'a' } }) });
    controller.setState({ sessions: [session(), session({ id: 's2', project: null, title: 'Solta' })] });
    controller.setVisible(true);
    expect(el.innerHTML).toContain('Outros');
    click(listeners, { '[data-kb-filter]': { dataset: { kbFilter: 'project', value: '__other__' } } });
    expect(el.innerHTML).toContain('Solta');
    expect(el.innerHTML).not.toContain('>Tarefa<');
    click(listeners, { '[data-kb-filter]': { dataset: { kbFilter: 'needsMe' } } });
    expect(el.innerHTML).toContain('nenhum agente rodando');
  });
});
