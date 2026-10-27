// The GitHub tab: reads the project's issues and PRs through main, draws them
// and wires the row actions. No globals: DOM root, IPC api and clock come in,
// so vitest drives it with fakes. It reads and schedules only while visible.
import { renderGithub } from './github-view.js';

export const REFRESH_MS = 5 * 60 * 1000;

// deps:
//   el              the #view-github element
//   api             { githubRepos, githubList, githubBody, githubPull,
//                     githubReview, githubOpen }
//   projects()      root -> { name, uri, accent } for the workspace's projects
//   openWorkspace() shows the Workspace tab (a pulled chat opens there)
//   notify(text)    a short message for the user
export function createGithubController({
  el,
  api,
  projects = () => ({}),
  openWorkspace = () => {},
  notify = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  let visible = false;
  let repos = null; // root -> owner/repo, GitHub projects only
  let project = null;
  let timer = null;
  let seq = 0; // the newest read; an older answer is dropped
  let selected = null;
  let body = null;
  let lastHtml = null;
  const filter = { mine: false, unassigned: false, label: '', text: '' };
  const loaded = new Map(); // root -> { data, chats }

  function projectList() {
    const known = projects();
    return Object.entries(repos ?? {}).map(([root, repo]) => ({ root, repo, name: known[root]?.name ?? root.split('/').pop(), uri: known[root]?.uri, accent: known[root]?.accent }));
  }

  function render() {
    if (!visible) return;
    const entry = loaded.get(project);
    const html = renderGithub({
      project,
      projects: repos ? projectList() : [{ root: '', name: '…', repo: '' }],
      data: entry?.data ?? null,
      chats: entry?.chats ?? {},
      filter,
      selected,
      body,
      now: now(),
    });
    if (html === lastHtml) return;
    // A state push must not eat what is being typed in the search box.
    const input = el.querySelector?.('.gh-search');
    const typed = input && document.activeElement === input ? { value: input.value, start: input.selectionStart } : null;
    lastHtml = html;
    el.innerHTML = html;
    const fresh = el.querySelector?.('.gh-search');
    if (typed && fresh) {
      fresh.value = typed.value;
      fresh.focus();
      fresh.setSelectionRange?.(typed.start, typed.start);
    }
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  // One timeout, set again after each read: never an interval.
  function schedule() {
    cancelTimer();
    if (!visible) return;
    timer = setTimer(() => {
      timer = null;
      read({ force: true });
    }, REFRESH_MS);
  }

  async function read({ force = false } = {}) {
    if (!visible || !project) return;
    const mine = ++seq;
    const root = project;
    const result = await Promise.resolve(api.githubList(root, force)).catch((error) => ({ error: String(error?.message ?? error) }));
    if (mine !== seq || !visible) return;
    if (result?.data) loaded.set(root, { data: result.data, chats: result.chats ?? {} });
    else loaded.set(root, { data: { at: now(), issues: { error: result?.error ?? 'sem resposta' }, mine: [], prs: { error: result?.error ?? 'sem resposta' } }, chats: {} });
    render();
    schedule();
  }

  async function start() {
    render();
    if (!repos) {
      const found = await Promise.resolve(api.githubRepos()).catch(() => ({}));
      if (!visible) return;
      repos = found ?? {};
    }
    if (!project || !(project in repos)) project = Object.keys(repos)[0] ?? null;
    if (!project) return render();
    // The cache is good for one refresh period; older, the tab reads again.
    const entry = loaded.get(project);
    render();
    await read({ force: !entry || now() - entry.data.at >= REFRESH_MS });
  }

  function select(kind, number) {
    selected = { kind, number };
    body = null;
    render();
    const root = project;
    Promise.resolve(api.githubBody(root, kind, number))
      .then((text) => (typeof text === 'string' ? text : null))
      .catch(() => null)
      .then((text) => {
        if (selected?.kind !== kind || selected?.number !== number || project !== root) return;
        body = text ?? '_não deu pra ler o texto_';
        render();
      });
  }

  async function act(action, kind, number) {
    if (action === 'refresh') {
      lastHtml = null;
      return read({ force: true });
    }
    if (action === 'open') return api.githubOpen(project, kind, number);
    if (action !== 'pull' && action !== 'review') return;
    // The chat opens in the Workspace; main answers once it is up (or not).
    openWorkspace();
    const outcome = await Promise.resolve(action === 'pull' ? api.githubPull(project, number) : api.githubReview(project, number)).catch(() => ({ error: 'Não consegui abrir o chat.' }));
    if (outcome?.error) notify(outcome.error);
  }

  el.addEventListener('click', (event) => {
    const target = event.target;
    const picked = target.closest?.('[data-gh-project]');
    if (picked) {
      if (picked.dataset.ghProject === project) return;
      project = picked.dataset.ghProject;
      selected = null;
      body = null;
      lastHtml = null;
      render();
      read({ force: !loaded.has(project) || now() - loaded.get(project).data.at >= REFRESH_MS });
      return;
    }
    const button = target.closest?.('[data-action]');
    if (button) {
      const row = button.closest?.('[data-gh-number]');
      const number = Number(button.dataset.ghNumber ?? row?.dataset.ghNumber);
      const kind = button.dataset.ghKind ?? row?.dataset.ghKind ?? (button.dataset.action === 'review' ? 'pr' : 'issue');
      act(button.dataset.action, kind, number);
      return;
    }
    const chip = target.closest?.('button[data-gh-filter]');
    if (chip) {
      filter[chip.dataset.ghFilter] = !filter[chip.dataset.ghFilter];
      render();
      return;
    }
    const row = target.closest?.('[data-gh-number]');
    if (row) select(row.dataset.ghKind, Number(row.dataset.ghNumber));
  });

  el.addEventListener('input', (event) => {
    const field = event.target;
    if (field?.dataset?.ghFilter === 'text') {
      filter.text = field.value;
      render();
    }
  });
  el.addEventListener('change', (event) => {
    const field = event.target;
    if (field?.dataset?.ghFilter === 'label') {
      filter.label = field.value;
      render();
    }
  });

  return {
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) {
        seq++; // an answer arriving now is not drawn
        cancelTimer();
        return;
      }
      lastHtml = null;
      start();
    },
    // The avatars' accents arrive asynchronously: draw again with them.
    refresh: render,
    hasTimer: () => timer !== null,
  };
}
