import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import {
  renderCards,
  renderComposer,
  renderFileView,
  renderInspectorHeader,
  renderRail,
  renderSidebar,
  renderTabs,
  renderTaskPicker,
  renderTerminalPlaceholder,
  renderTimeline,
  renderTopBar,
} from './workspace-view.js';
import {
  acceptsFile,
  initialInspector,
  nextFileRequest,
  onFollow,
  onPickTask,
  onSelect,
  onTask,
} from './inspector-state.js';

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

const inspectorHead = document.getElementById('inspector-head');
const taskPickerEl = document.getElementById('task-picker');
const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const railEl = document.getElementById('rail');
const prefs = { mode: 'arquivo', width: 'compact' };
let lastOpenWidth = 'compact';
let inspector = initialInspector(null);
let inspectorTask = null;
let inspectorSummaries = [];
let fileView = null;
let scrollPending = false; // scroll to the selection once its element renders
let fileSignature = null; // what the current fileView was built from
let inspectorComments = []; // the selected session's 💬 comments
// The composer lives outside #detail/#timeline: edit pings re-render those,
// never the draft being typed.
const composerEl = document.getElementById('composer');
let composer = null; // { editId, draft, error }
let pickerSignature = null;

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
    window.vizor.setTerminalTitle(id, title);
    renderTerminalArea();
  });
  const replay = await window.vizor.terminalBuffer(id);
  // Removed while the replay was loading: the view is already disposed (#111).
  if (views.get(id) !== view) return view;
  term.write(replay);
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
  sidebar.innerHTML = renderSidebar(lastTree, selectedId, selectedWorktree);
  renderTerminalArea();
}

// --- inspector (#93) ---------------------------------------------------------
// Never calls focus(): the terminal keeps the keyboard while changes update.

function selectedEdit() {
  return inspectorTask?.edits.find((edit) => edit.id === inspector.selectedId) ?? null;
}

function renderInspector() {
  document.body.dataset.inspectorWidth = prefs.width;
  const edits = inspectorTask?.edits ?? [];
  const writing = edits.some((edit) => edit.status === 'writing');
  railEl.innerHTML = renderRail({ editCount: edits.length, writing });
  inspectorHead.innerHTML = renderInspectorHeader({ mode: prefs.mode, width: prefs.width, editCount: edits.length, writing });
  // Rebuilt only when it changes: an open dropdown must survive edit pings.
  const picker = inspector.sessionId ? renderTaskPicker(inspectorSummaries, inspector.taskId) : '';
  if (picker !== pickerSignature) {
    pickerSignature = picker;
    taskPickerEl.innerHTML = picker;
  }
  timelineEl.innerHTML = renderTimeline(inspectorTask, inspector.selectedId, inspector);
  // Keep the reader's place: the selected item stays where it was on screen
  // even when the AI inserts lines above it.
  const anchorSelector =
    prefs.mode === 'cards' ? '[data-card][aria-current="true"]' : '[data-banner][aria-current="true"]';
  const anchorBefore = detailEl.querySelector(anchorSelector);
  const offsetBefore = anchorBefore ? anchorBefore.offsetTop - detailEl.scrollTop : null;
  const commentsByEdit = {};
  for (const comment of inspectorComments) (commentsByEdit[comment.editId] ??= []).push(comment);
  if (prefs.mode === 'cards') detailEl.innerHTML = renderCards(inspectorTask, inspector.selectedId, commentsByEdit);
  else if (fileView && !fileView.error) {
    const byId = Object.fromEntries(edits.map((edit) => [edit.id, edit]));
    detailEl.innerHTML = renderFileView(fileView, byId, inspector.selectedId, commentsByEdit);
  } else detailEl.innerHTML = '';
  const anchor = detailEl.querySelector(anchorSelector);
  // A pending scroll waits until its target exists: following an edit that
  // is still being written, the banner only appears once it lands.
  if (scrollPending && anchor) {
    scrollPending = false;
    anchor.scrollIntoView({ block: 'center' });
    timelineEl.querySelector('[data-edit][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else if (anchor && offsetBefore !== null) detailEl.scrollTop = anchor.offsetTop - offsetBefore;
}

// What the file view depends on: the selected file's edits. Pings about
// other files (or a reason arriving) must not re-fetch a 2 MB file.
function selectedFileSignature() {
  const edit = selectedEdit();
  if (!edit) return null;
  return `${inspector.sessionId}|${inspector.taskId}|${edit.filePath}|${(inspectorTask?.edits ?? [])
    .filter((item) => item.filePath === edit.filePath)
    .map((item) => `${item.id}:${item.status}:${item.endedAt}`)
    .join(',')}`;
}

async function loadFileView() {
  const edit = selectedEdit();
  if (prefs.mode !== 'arquivo' || !edit) {
    fileView = null;
    fileSignature = null;
    renderInspector();
    return;
  }
  // Collapsed: nothing to show, fetch when it opens.
  if (prefs.width === 'collapsed') {
    renderInspector();
    return;
  }
  const signature = selectedFileSignature();
  if (fileView && signature === fileSignature) {
    renderInspector();
    return;
  }
  // Nothing on disk to show yet for an edit in flight.
  if (edit.status === 'writing') {
    fileView = { relPath: edit.relPath, rows: [], anchors: {}, unplaced: [], note: 'writing' };
    renderInspector();
    return;
  }
  const request = nextFileRequest(inspector);
  inspector = request.state;
  const result = await window.vizor.getFileView(inspector.sessionId, inspector.taskId, edit.filePath);
  if (!acceptsFile(inspector, request.token)) return;
  fileView = result;
  fileSignature = signature;
  renderInspector();
}

async function refreshInspector({ scroll = false } = {}) {
  const sessionId = inspector.sessionId;
  if (!sessionId) {
    inspectorTask = null;
    inspectorSummaries = [];
    fileView = null;
    renderInspector();
    return;
  }
  const before = inspector.selectedId;
  const { task, summaries, comments } = await window.vizor.getTaskEdits(sessionId, inspector.taskId);
  if (inspector.sessionId !== sessionId) return; // switched meanwhile
  inspectorTask = task;
  inspectorSummaries = summaries;
  inspectorComments = comments ?? [];
  inspector = onTask(inspector, task);
  // Scroll only when the selection moved (following, or a click) — never on a
  // plain refresh of the same selection.
  if (scroll || inspector.selectedId !== before) scrollPending = true;
  await loadFileView();
}

function renderComposerPanel() {
  const edit = composer && inspectorTask?.edits.find((item) => item.id === composer.editId);
  composerEl.hidden = !edit;
  if (!edit) return;
  composerEl.innerHTML = renderComposer({ edit, draft: composer.draft, error: composer.error });
  const textarea = composerEl.querySelector('[data-comment-draft]');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function closeComposer() {
  composer = null;
  composerEl.hidden = true;
  composerEl.innerHTML = '';
  // Back to the terminal the user was typing in.
  views.get(activeTab)?.term.focus();
}

async function sendComposer() {
  // One send per click: Ctrl+Enter plus a click must not queue it twice.
  if (!composer || composer.sending) return;
  composer.sending = true;
  const result = await window.vizor.addComment(inspector.sessionId, composer.editId, composer.draft);
  if (composer) composer.sending = false;
  if (!result?.ok) {
    composer.error = result?.error ?? 'Não deu pra comentar';
    renderComposerPanel();
    return;
  }
  closeComposer();
  refreshInspector();
}

composerEl.addEventListener('input', (event) => {
  if (composer && event.target.matches('[data-comment-draft]')) composer.draft = event.target.value;
});

composerEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeComposer();
  } else if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    sendComposer();
  }
});

function selectInspectorSession(sessionId) {
  if (inspector.sessionId === sessionId) return;
  if (composer) closeComposer();
  inspector = initialInspector(sessionId);
  inspectorTask = null;
  fileView = null;
  refreshInspector({ scroll: true });
}

async function savePrefs(change) {
  Object.assign(prefs, change);
  if (prefs.width !== 'collapsed') lastOpenWidth = prefs.width;
  renderInspector();
  await window.vizor.setPrefs({ mode: prefs.mode, width: prefs.width });
}

window.vizor.onEditsChanged(({ sessionId }) => {
  if (sessionId === inspector.sessionId) refreshInspector();
});

window.vizor.getPrefs().then((saved) => {
  Object.assign(prefs, saved);
  if (prefs.width !== 'collapsed') lastOpenWidth = prefs.width;
  renderInspector();
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    savePrefs({ width: prefs.width === 'collapsed' ? lastOpenWidth : 'collapsed' }).then(() => loadFileView());
  }
});

document.addEventListener('change', (event) => {
  const picker = event.target.closest('[data-task-picker]');
  if (!picker) return;
  inspector = onPickTask(inspector, picker.value || null);
  fileView = null;
  refreshInspector({ scroll: true });
});

window.vizor.onState(({ tree, terminals: list, theme, palette }) => {
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  lastTree = tree;
  terminals = list ?? [];
  if (pendingFocus && findSession(pendingFocus)) {
    const sessionId = pendingFocus;
    pendingFocus = null;
    queueMicrotask(() => selectSession(sessionId));
  }
  // Titles live in main too, so a reloaded window gets them back (#117).
  for (const terminal of terminals) if (terminal.title && !titles[terminal.id]) titles[terminal.id] = terminal.title;
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
  const commentButton = target.closest('[data-comment]');
  if (commentButton) {
    composer = { editId: commentButton.dataset.comment, draft: '', error: null };
    renderComposerPanel();
    return;
  }
  const copy = target.closest('[data-copy-comment]');
  if (copy) {
    window.vizor.copyComment(inspector.sessionId, copy.dataset.copyComment);
    copy.textContent = 'copiado';
    return;
  }
  if (target.closest('[data-comment-send]')) {
    sendComposer();
    return;
  }
  if (target.closest('[data-comment-cancel]')) {
    closeComposer();
    return;
  }
  if (target.closest('#composer')) return;
  const editRow = target.closest('[data-edit]');
  if (editRow) {
    inspector = onSelect(inspector, editRow.dataset.edit);
    scrollPending = true;
    await loadFileView();
    return;
  }
  const banner = target.closest('[data-banner]');
  if (banner) {
    inspector = onSelect(inspector, banner.dataset.banner);
    renderInspector();
    return;
  }
  if (target.closest('[data-follow]')) {
    inspector = onFollow(inspector);
    fileView = null;
    refreshInspector({ scroll: true });
    return;
  }
  const mode = target.closest('[data-mode]');
  if (mode) {
    scrollPending = true;
    await savePrefs({ mode: mode.dataset.mode });
    await loadFileView();
    return;
  }
  if (target.closest('[data-width-next]')) {
    savePrefs({ width: prefs.width === 'wide' ? 'compact' : 'wide' });
    return;
  }
  if (target.closest('[data-collapse]')) {
    savePrefs({ width: 'collapsed' });
    return;
  }
  if (target.closest('[data-expand]')) {
    await savePrefs({ width: lastOpenWidth });
    await loadFileView();
    return;
  }
  const remove = target.closest('[data-remove-project]');
  if (remove) {
    window.vizor.removeProject(remove.dataset.removeProject);
    return;
  }
  if (target.closest('[data-add-project]')) {
    window.vizor.addProject().catch(() => {}); // main logs the failure (#106)
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
    reportSelection();
    return;
  }
  const row = target.closest('[data-session]');
  if (row) selectSession(row.dataset.session);
});

// One way to select a session: a sidebar click, or main pointing the window
// at it (the bubble, a panel card — #96).
function selectSession(sessionId) {
  selectedId = sessionId;
  const selection = findSession(selectedId);
  if (selection?.worktree) selectedWorktree = selection.worktree.path;
  selectInspectorSession(selectedId);
  if (selection?.session.ptyId) {
    activeTab = selection.session.ptyId;
    // The pty may live in another folder (cd before claude): show its tabs (#119).
    const terminal = terminals.find((item) => item.id === activeTab);
    if (terminal) selectedWorktree = terminal.cwd;
  }
  render();
  reportSelection();
}

// Main mutes notices for the session this focused window is showing.
function reportSelection() {
  window.vizor.reportSelection(selectedId);
}

window.addEventListener('focus', reportSelection);

// A request that lands before the tree knows the session waits for it.
let pendingFocus = null;
window.vizor.onFocusSession(({ sessionId }) => {
  if (sessionId && !findSession(sessionId)) {
    pendingFocus = sessionId;
    return;
  }
  if (sessionId) selectSession(sessionId);
});
