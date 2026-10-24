import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { renderSidebar, renderTabs, renderTerminalPlaceholder, renderTopBar } from './workspace-view.js';

const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
const tabsBar = document.getElementById('tabs');
const termHost = document.getElementById('term-host');
const placeholder = document.getElementById('term-placeholder');

let lastTree = null;
let terminals = [];
let selectedId = null; // selected session
let selectedWorktree = null;
let activeTab = null;
// worktree path → why its terminal could not open; '*' when the native module
// itself failed to load (no terminal anywhere).
const unavailable = new Map();
const titles = {};
const views = new Map(); // pty id → { term, fit, el }

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function findSession(id) {
  for (const project of lastTree?.projects ?? [])
    for (const worktree of project.worktrees)
      for (const session of worktree.sessions) if (session.id === id) return { session, worktree };
  const loose = lastTree?.unplacedSessions?.find((session) => session.id === id);
  return loose ? { session: loose, worktree: null } : null;
}

// One xterm per pty, created once and kept: hiding a tab must not lose its
// screen. The scrollback replay happens before live data is subscribed, and
// data for a pty without a view is dropped — the replay already holds it.
async function ensureView(id) {
  if (views.has(id)) return views.get(id);
  const el = document.createElement('div');
  el.className = 'term';
  termHost.appendChild(el);
  const term = new Terminal({
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: cssVar('--bg-surface'), foreground: cssVar('--text'), cursor: cssVar('--accent') },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // no WebGL (driver, VM): xterm's default renderer still works
  }
  const view = { term, fit, el, ready: false };
  views.set(id, view);
  term.onData((data) => window.vizor.writeTerminal(id, data));
  term.onTitleChange((title) => {
    titles[id] = title;
    renderTerminalArea();
  });
  term.write(await window.vizor.terminalBuffer(id));
  view.ready = true;
  return view;
}

function fitActive() {
  const view = views.get(activeTab);
  if (!view || termHost.hidden) return;
  view.fit.fit();
  window.vizor.resizeTerminal(activeTab, view.term.cols, view.term.rows);
}

function worktreeTerminals() {
  return terminals.filter((terminal) => terminal.cwd === selectedWorktree);
}

async function renderTerminalArea() {
  const selection = selectedId ? findSession(selectedId) : null;
  if (selection && !selection.session.ptyId) {
    tabsBar.innerHTML = '';
    termHost.hidden = true;
    placeholder.hidden = false;
    placeholder.innerHTML = renderTerminalPlaceholder('outside');
    return;
  }
  const own = worktreeTerminals();
  if (!own.some((terminal) => terminal.id === activeTab)) activeTab = own.at(-1)?.id ?? null;
  tabsBar.innerHTML = selectedWorktree ? renderTabs(own, activeTab, titles) : '';
  const reason = unavailable.get('*') ?? unavailable.get(selectedWorktree);
  const showTerminal = Boolean(activeTab) && !reason;
  termHost.hidden = !showTerminal;
  placeholder.hidden = showTerminal;
  if (!showTerminal) {
    placeholder.innerHTML = renderTerminalPlaceholder(reason ? `unavailable:${reason}` : 'none');
    return;
  }
  const wanted = activeTab;
  const view = await ensureView(wanted);
  // Another render may have switched tabs (or dropped this one) while the
  // replay was loading: focusing this view now would send keys to a hidden
  // terminal.
  if (wanted !== activeTab || views.get(wanted) !== view) return;
  for (const [id, other] of views) other.el.hidden = id !== activeTab;
  fitActive();
  view.term.focus();
}

function render() {
  if (!lastTree) return;
  topbar.innerHTML = renderTopBar(lastTree);
  sidebar.innerHTML = renderSidebar(lastTree, selectedId);
  renderTerminalArea();
}

window.vizor.onState(({ tree, terminals: list, theme, palette }) => {
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  lastTree = tree;
  terminals = list ?? [];
  for (const id of [...views.keys()]) {
    if (terminals.some((terminal) => terminal.id === id)) continue;
    views.get(id).term.dispose();
    views.get(id).el.remove();
    views.delete(id);
  }
  render();
});

window.vizor.onTerminalData(({ id, data }) => {
  const view = views.get(id);
  if (view?.ready) view.term.write(data);
});

window.vizor.onTerminalExit(() => renderTerminalArea());

new ResizeObserver(() => fitActive()).observe(termHost);

document.addEventListener('click', async (event) => {
  const target = event.target;
  const remove = target.closest('[data-remove-project]');
  if (remove) {
    window.vizor.removeProject(remove.dataset.removeProject);
    return;
  }
  if (target.closest('[data-add-project]')) {
    window.vizor.addProject();
    return;
  }
  const close = target.closest('[data-close-tab]');
  if (close) {
    const id = close.dataset.closeTab;
    const alive = terminals.find((terminal) => terminal.id === id)?.alive;
    if (!alive || window.confirm('Encerrar este terminal?')) window.vizor.closeTerminal(id);
    return;
  }
  const tab = target.closest('[data-tab]');
  if (tab) {
    activeTab = tab.dataset.tab;
    unavailable.delete(selectedWorktree);
    renderTerminalArea();
    return;
  }
  if (target.closest('[data-new-terminal]')) {
    if (!selectedWorktree) return;
    const worktree = selectedWorktree;
    const result = await window.vizor.openTerminal(worktree, true);
    if (result?.error) {
      // Only a failed native load blocks every worktree; a missing folder is
      // that worktree's problem alone.
      unavailable.set(result.error === 'pasta não existe' ? worktree : '*', result.error);
      renderTerminalArea();
      return;
    }
    unavailable.delete(worktree);
    activeTab = result.id;
    // The state push that lists the new terminal can arrive before this
    // reply, rendering with the old tab still active.
    renderTerminalArea();
    return;
  }
  if (target.closest('[data-focus-outside]')) {
    if (selectedId) window.vizor.focusOutside(selectedId);
    return;
  }
  const worktree = target.closest('[data-worktree]');
  if (worktree) {
    selectedWorktree = worktree.dataset.worktree;
    selectedId = null;
    render();
    return;
  }
  const row = target.closest('[data-session]');
  if (row) {
    selectedId = row.dataset.session;
    const selection = findSession(selectedId);
    if (selection?.worktree) selectedWorktree = selection.worktree.path;
    if (selection?.session.ptyId) activeTab = selection.session.ptyId;
    render();
  }
});
