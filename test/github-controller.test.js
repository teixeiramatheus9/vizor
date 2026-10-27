import { describe, it, expect, vi } from 'vitest';
import { createGithubController, REFRESH_MS } from '../src/renderer/github/github-controller.js';

const NOW = 1_000_000_000;

function setup(overrides = {}) {
  const listeners = {};
  const el = { innerHTML: '', addEventListener: (type, fn) => (listeners[type] = fn), querySelector: () => null };
  const data = { at: NOW, issues: [{ number: 7, title: 'Hello', labels: [], assignees: [] }], mine: [], prs: [{ number: 9, title: 'Pr', checks: 'ok' }] };
  const api = {
    githubRepos: vi.fn(async () => ({ '/p/a': 'o/a', '/p/b': 'o/b' })),
    githubList: vi.fn(async () => ({ data, chats: { 7: { state: 'trabalhando' } } })),
    githubBody: vi.fn(async () => 'corpo'),
    githubPull: vi.fn(async () => ({ sessionId: 's' })),
    githubReview: vi.fn(async () => ({ sessionId: 's' })),
    githubOpen: vi.fn(),
  };
  const timers = [];
  const clock = { now: NOW };
  const openWorkspace = vi.fn();
  const notify = vi.fn();
  const controller = createGithubController({
    el, api, openWorkspace, notify,
    projects: () => ({ '/p/a': { name: 'a' }, '/p/b': { name: 'b' } }),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => (handle.cleared = true),
    ...overrides,
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const target = (match) => ({ closest: (selector) => (selector in match ? match[selector] : null) });
  return { el, api, listeners, controller, timers, live, clock, openWorkspace, notify, flush, target, data };
}

describe('github controller', () => {
  it('reads and draws nothing while hidden', async () => {
    const t = setup();
    await t.flush();
    expect(t.api.githubRepos).not.toHaveBeenCalled();
    expect(t.api.githubList).not.toHaveBeenCalled();
    expect(t.el.innerHTML).toBe('');
    expect(t.live()).toHaveLength(0);
  });

  it('reads on show, draws, and arms exactly one 5-minute timeout', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    expect(t.api.githubList).toHaveBeenCalledWith('/p/a', true);
    expect(t.el.innerHTML).toContain('Hello');
    expect(t.el.innerHTML).toContain('trabalhando');
    expect(t.live()).toHaveLength(1);
    expect(t.live()[0].ms).toBe(REFRESH_MS);
  });

  it('the timer forces a read and arms the next one', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    const fired = t.live()[0];
    fired.cleared = true; // a timeout that fired is gone
    fired.fn();
    await t.flush();
    expect(t.api.githubList).toHaveBeenCalledTimes(2);
    expect(t.api.githubList).toHaveBeenLastCalledWith('/p/a', true);
    expect(t.live()).toHaveLength(1);
  });

  it('leaving the tab cancels the timer and drops a late answer', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.controller.setVisible(false);
    expect(t.live()).toHaveLength(0);
    t.controller.setVisible(true);
    t.controller.setVisible(false);
    await t.flush();
    expect(t.live()).toHaveLength(0);
  });

  it('coming back inside the period uses the cache', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.controller.setVisible(false);
    t.clock.now += 60_000;
    t.controller.setVisible(true);
    await t.flush();
    expect(t.api.githubList).toHaveBeenLastCalledWith('/p/a', false);
    t.controller.setVisible(false);
    t.clock.now += REFRESH_MS;
    t.controller.setVisible(true);
    await t.flush();
    expect(t.api.githubList).toHaveBeenLastCalledWith('/p/a', true);
  });

  it('pull sends the tab project root, switches to the Workspace and reports errors', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.api.githubPull.mockResolvedValueOnce({ error: 'falhou' });
    const row = { dataset: { ghNumber: '7', ghKind: 'issue' } };
    t.listeners.click({ target: t.target({ '[data-action]': { dataset: { action: 'pull', ghNumber: '7' }, closest: () => row } }) });
    await t.flush();
    expect(t.api.githubPull).toHaveBeenCalledWith('/p/a', 7);
    expect(t.openWorkspace).toHaveBeenCalled();
    expect(t.notify).toHaveBeenCalledWith('falhou');
  });

  it('review and open use the tab root too', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.listeners.click({ target: t.target({ '[data-action]': { dataset: { action: 'review', ghNumber: '9' }, closest: () => null } }) });
    t.listeners.click({ target: t.target({ '[data-action]': { dataset: { action: 'open', ghNumber: '9', ghKind: 'pr' }, closest: () => null } }) });
    await t.flush();
    expect(t.api.githubReview).toHaveBeenCalledWith('/p/a', 9);
    expect(t.api.githubOpen).toHaveBeenCalledWith('/p/a', 'pr', 9);
  });

  it('selecting a row loads its body lazily', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.listeners.click({ target: t.target({ '[data-gh-number]': { dataset: { ghNumber: '7', ghKind: 'issue' } } }) });
    await t.flush();
    expect(t.api.githubBody).toHaveBeenCalledWith('/p/a', 'issue', 7);
    expect(t.el.innerHTML).toContain('corpo');
  });

  it('switching project reads that project', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.listeners.click({ target: t.target({ '[data-gh-project]': { dataset: { ghProject: '/p/b' } } }) });
    await t.flush();
    expect(t.api.githubList).toHaveBeenLastCalledWith('/p/b', true);
  });

  it('a failed read shows an error instead of an endless skeleton', async () => {
    const t = setup();
    t.api.githubList.mockResolvedValue({ error: 'sem rede' });
    t.controller.setVisible(true);
    await t.flush();
    expect(t.el.innerHTML).toContain('sem rede');
  });

  it('a failed refresh keeps the last good list and says so', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.api.githubList.mockResolvedValue({ data: { at: NOW + 1, issues: t.data.issues, mine: [], prs: { error: 'rate limit' } }, chats: {} });
    t.clock.now += REFRESH_MS;
    const fired = t.live()[0];
    fired.cleared = true;
    fired.fn();
    await t.flush();
    expect(t.el.innerHTML).toContain('Pr'); // the old PR is still listed
    expect(t.el.innerHTML).toContain('não deu pra atualizar as PRs: rate limit');
    expect(t.el.innerHTML).toContain('há 5 min');
  });

  it('a whole failed call keeps what was loaded', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    t.api.githubList.mockResolvedValue({ error: 'sem rede' });
    t.clock.now += REFRESH_MS;
    const fired = t.live()[0];
    fired.cleared = true;
    fired.fn();
    await t.flush();
    expect(t.el.innerHTML).toContain('Hello');
    expect(t.el.innerHTML).toContain('sem rede');
  });

  it('reads the project list again on each show, so a project added meanwhile appears', async () => {
    const t = setup();
    t.controller.setVisible(true);
    await t.flush();
    expect(t.el.innerHTML).not.toContain('o/c');
    t.controller.setVisible(false);
    t.api.githubRepos.mockResolvedValue({ '/p/a': 'o/a', '/p/b': 'o/b', '/p/c': 'o/c' });
    t.controller.setVisible(true);
    await t.flush();
    expect(t.api.githubRepos).toHaveBeenCalledTimes(2);
    expect(t.el.innerHTML).toContain('data-gh-project="/p/c"');
  });

  it('a whole failed call keeps the "mine" list too', async () => {
    const t = setup();
    t.api.githubList.mockResolvedValueOnce({ data: { ...t.data, mine: [{ number: 7, title: 'Hello', labels: [], assignees: [] }] }, chats: {} });
    t.controller.setVisible(true);
    await t.flush();
    t.api.githubList.mockResolvedValue({ error: 'sem rede' });
    t.clock.now += REFRESH_MS;
    const fired = t.live()[0];
    fired.cleared = true;
    fired.fn();
    await t.flush();
    t.listeners.click({ target: t.target({ 'button[data-gh-filter]': { dataset: { ghFilter: 'mine' } } }) });
    expect(t.el.innerHTML).toContain('Hello');
  });
});
