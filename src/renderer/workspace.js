import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { renderGuardCard } from './guard-card.js';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import {
  renderCards,
  renderComposer,
  renderFileView,
  renderInspectorHeader,
  renderNewTerminalMenu,
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
  stillWanted,
} from './inspector-state.js';
import { renderPlan } from './plan-view.js';
import { buildCommands, filterCommands, renderCommandList } from './command-bar.js';
import { renderBackstage, renderBalloon, renderConsequences, renderImpact, renderOrchestra, renderOrder } from './maestro-view.js';
import { ZOOM_MAX, ZOOM_OPEN, ZOOM_STEP, layoutGraph, moduleAt, renderGraph } from './graph-view.js';

const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
const tabsBar = document.getElementById('tabs');
const termHost = document.getElementById('term-host');
const placeholder = document.getElementById('term-placeholder');
const newMenu = document.getElementById('new-menu');

let lastTree = null;
// The voice mode (#161): the chat can fold away so the code takes the screen.
let chatHidden = false;
// The Maestro stage (#159): on, the orchestra and the focused músico, from main.
let maestro = { on: false, orchestra: [], focusedId: null };
let voiceInfo = null;
let terminals = [];
let selectedId = null; // selected session
// While Ctrl+K is open nothing takes the keyboard from it (live test: a tab
// restored at boot focused its terminal and "169⏎" ran in the shell).
function commandBarOpen() {
  return document.getElementById('command-bar')?.hidden === false;
}
let plans = {}; // sessionId → { steps, approved }
let planNote = null; // { sessionId, text } after a button that did not land
const planCardEl = document.getElementById('plan-card');
let selectedWorktree = null;
let activeTab = null;
// worktree path → why its terminal could not open; '*' when the native module
// itself failed to load (no terminal anywhere).
const unavailable = new Map();
const titles = {};
const views = new Map(); // pty id → { term, fit, el }
// A tab opened from outside the tab bar (bring, restore): selected once the
// state push lists it.
let pendingTab = null;
let lastReportedTab;
let adoptedActive = false;

// Folded projects, worktrees and file lists (#152): a per-viewer convenience,
// so localStorage — and a sidebar that renders fine without it.
const FOLDS_KEY = 'vizor.workspace.folds';
let folds = {};
try {
  folds = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') ?? {};
} catch {
  folds = {};
}

function saveFolds() {
  // Choices about sessions that are gone would pile up forever.
  const known = new Set(
    [...(lastTree?.projects ?? []).flatMap((project) => project.worktrees.flatMap((worktree) => worktree.sessions)), ...(lastTree?.unplacedSessions ?? [])].map(
      (session) => `s:${session.id}`,
    ),
  );
  for (const key of Object.keys(folds)) if (key.startsWith('s:') && !known.has(key)) delete folds[key];
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // private storage off: folds just last until the window reloads
  }
}

// "Trazer pro Vizor" (#156): what main says about each outside chat, asked
// again after a few seconds — its process may end meanwhile.
const outsideStatus = new Map(); // session id → { value, at }
const OUTSIDE_STATUS_TTL = 3000;
let outsideAsking = null;

async function askOutsideStatus(sessionId) {
  if (outsideAsking === sessionId) return;
  outsideAsking = sessionId;
  const value = await window.vizor.outsideStatus(sessionId);
  outsideAsking = null;
  const before = JSON.stringify(outsideStatus.get(sessionId)?.value ?? null);
  outsideStatus.set(sessionId, { value, at: Date.now() });
  if (selectedId === sessionId && JSON.stringify(value) !== before) renderTerminalArea();
}

// The + menu (#154).
let menuConversations = null;

function closeMenu() {
  newMenu.hidden = true;
  newMenu.innerHTML = '';
  menuConversations = null;
}

function renderMenu() {
  newMenu.innerHTML = renderNewTerminalMenu({ conversations: menuConversations, now: Date.now() });
}

async function openMenu(anchor) {
  const worktree = selectedWorktree;
  menuConversations = null;
  newMenu.hidden = false;
  renderMenu();
  const box = anchor.getBoundingClientRect();
  const pane = newMenu.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  newMenu.style.left = `${Math.max(4, box.left - pane.left)}px`;
  newMenu.style.top = `${box.bottom - pane.top + 2}px`;
  const list = await window.vizor.listConversations(worktree);
  // Closed, or moved to another worktree, while the list was loading.
  if (newMenu.hidden || worktree !== selectedWorktree) return;
  menuConversations = list;
  renderMenu();
}

async function openNewTerminal(kind, sessionId = null) {
  closeMenu();
  if (!selectedWorktree) return;
  const worktree = selectedWorktree;
  const result = await window.vizor.openTerminal(worktree, kind, sessionId);
  if (result?.error) {
    // Only a failed native load blocks every worktree; a missing folder is
    // that worktree's problem alone; a bad request is nobody's.
    if (result.error === 'pasta não existe') unavailable.set(worktree, result.error);
    else if (!['conversa inválida', 'tipo de terminal inválido'].includes(result.error)) unavailable.set('*', result.error);
    renderTerminalArea();
    return;
  }
  unavailable.delete(worktree);
  activeTab = result.id;
  reportSelection();
  // The state push that lists the new terminal can arrive before this
  // reply, rendering with the old tab still active.
  renderTerminalArea();
}

// A tab opened outside the tab bar: shown at once when the state already
// lists it, else as soon as a push does.
function focusNewTab(id) {
  const terminal = terminals.find((item) => item.id === id);
  if (!terminal) {
    pendingTab = id;
    return;
  }
  pendingTab = null;
  selectedWorktree = terminal.cwd;
  activeTab = terminal.id;
  render();
  reportSelection();
}

// Main restores this on the next start (#155).
// Only a real tab: browsing a worktree with none must not erase the one to
// bring back (review).
function reportActiveTab() {
  if (!activeTab || activeTab === lastReportedTab) return;
  lastReportedTab = activeTab;
  window.vizor.reportActiveTab(activeTab);
}

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
    const status = outsideStatus.get(selectedId);
    placeholder.innerHTML = renderTerminalPlaceholder('outside', status?.value ?? null);
    if (!status || Date.now() - status.at > OUTSIDE_STATUS_TTL) askOutsideStatus(selectedId);
    return;
  }
  const own = worktreeTerminals();
  if (!own.some((terminal) => terminal.id === activeTab)) activeTab = own.at(-1)?.id ?? null;
  reportActiveTab();
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
  if (!commandBarOpen()) view.term.focus();
}

function render() {
  if (!lastTree) return;
  topbar.innerHTML = renderTopBar(lastTree, { chatHidden, voice: voiceInfo, maestro: maestro.on });
  sidebar.innerHTML = renderSidebar(lastTree, selectedId, selectedWorktree, folds);
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
    inspectorComments = [];
    fileView = null;
    fileSignature = null;
    renderInspector();
    return;
  }
  const before = inspector.selectedId;
  const askedFor = inspector.taskId;
  const { task, summaries, comments } = await window.vizor.getTaskEdits(sessionId, askedFor);
  // Switched session or task meanwhile: this answer is for a view gone.
  if (inspector.sessionId !== sessionId || !stillWanted(inspector, askedFor)) return;
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
  // The composer keeps its own copy of the change: picking another task in
  // the picker must not hide it or lose the draft (review I-4 of #136).
  const edit = composer?.edit ?? null;
  if (!edit) {
    // Its change left the view (another task, another session): no hidden
    // composer keeping state behind the scenes (#136).
    composer = null;
    composerEl.hidden = true;
    composerEl.innerHTML = '';
    return;
  }
  composerEl.hidden = false;
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
  if (!commandBarOpen()) views.get(activeTab)?.term.focus();
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
  // null: nothing selected — the inspector empties instead of showing the
  // previous session's changes (#124).
  if (composer) closeComposer();
  inspector = initialInspector(sessionId);
  inspectorTask = null;
  fileView = null;
  refreshInspector({ scroll: true });
  renderPlanCard();
}

// --- The plan (core flow) ----------------------------------------------------
// The checklist the chat keeps in .vizor/plano.md: of the inspected chat, or
// of the músico in focus on the stage.
// The inspected chat, else the chat running in the tab in front (live test: the
// inspector lost its session when the chat's worktree moved in the tree, and
// the card went blank mid-task).
const planSessionId = () => {
  if (maestro.on) return maestro.focusedId;
  if (inspector.sessionId) return inspector.sessionId;
  if (!activeTab) return null;
  return treeSessions().find((session) => session.ptyId === activeTab)?.id ?? null;
};
function renderPlanCard() {
  const sessionId = planSessionId();
  const note = planNote?.sessionId === sessionId ? `<div class="plan-note">${planNote.text}</div>` : '';
  planCardEl.innerHTML = sessionId ? renderPlan(plans[sessionId]) + (plans[sessionId] ? note : '') : '';
}
const PLAN_NOTES = {
  failed: 'não achei a aba desse chat',
  timeout: 'o chat não ficou livre em 1 minuto; tente de novo quando ele parar',
  busy: 'já estou esperando o chat ficar livre pra mandar',
  'no-plan': 'esse chat não tem plano',
};
planCardEl.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-plan]');
  const sessionId = planSessionId();
  if (!button || !sessionId) return;
  button.disabled = true;
  const result = await window.vizor.planAction(sessionId, button.dataset.plan);
  planNote = PLAN_NOTES[result] ? { sessionId, text: PLAN_NOTES[result] } : null;
  renderPlanCard();
});

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
  if (event.key === 'Escape' && !newMenu.hidden) {
    event.preventDefault();
    closeMenu();
    if (!commandBarOpen()) views.get(activeTab)?.term.focus();
    return;
  }
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

// The rule guard's questions (#160) float over the terminals until answered.
const guardHost = document.getElementById('guard-asks');
function renderGuardAsks(asks = []) {
  guardHost.hidden = asks.length === 0;
  guardHost.innerHTML = asks.map(renderGuardCard).join('');
}
guardHost.addEventListener('click', (event) => {
  const button = event.target.closest('[data-guard-choice]');
  if (!button) return;
  button.closest('.guard-card')?.classList.add('answered');
  window.vizor.answerGuard(button.dataset.guardId, button.dataset.guardChoice);
});

window.vizor.onState(({ tree, terminals: list, activeTerminal, theme, palette, guardAsks, voice, maestro: stage, plans: planState }) => {
  plans = planState ?? {};
  renderGuardAsks(guardAsks);
  voiceInfo = voice ?? null;
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  lastTree = tree;
  terminals = list ?? [];
  // First state of this page: open on the tab that was in front (#155).
  if (!adoptedActive) {
    adoptedActive = true;
    if (!selectedWorktree && !selectedId && activeTerminal) pendingTab = activeTerminal;
  }
  const pending = pendingTab && terminals.find((terminal) => terminal.id === pendingTab);
  if (pending) {
    pendingTab = null;
    selectedWorktree = pending.cwd;
    activeTab = pending.id;
  }
  // The inspected session is gone (closed, reaped): stop showing it (#124).
  if (inspector.sessionId && !findSession(inspector.sessionId)) {
    if (selectedId === inspector.sessionId) selectedId = null;
    selectInspectorSession(null);
  }
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
  applyMaestro(stage);
  renderPlanCard();
});

// Flow control (#113): tell main how much each terminal has actually drawn,
// batched; main pauses a pty that runs too far ahead of the screen.
const acks = new Map();
let ackTimer = null;
function ack(id, chars) {
  acks.set(id, (acks.get(id) ?? 0) + chars);
  if (ackTimer) return;
  ackTimer = setTimeout(() => {
    ackTimer = null;
    for (const [terminalId, count] of acks) window.vizor.ackTerminal(terminalId, count);
    acks.clear();
  }, 50);
}

window.vizor.onTerminalData(({ id, data }) => {
  const view = views.get(id);
  // Dropped data (no view yet: the replay carries it) is acked too.
  if (view?.ready) view.term.write(data, () => ack(id, data.length));
  else ack(id, data.length);
});

window.vizor.onTerminalExit(() => renderTerminalArea());

new ResizeObserver(() => fitActive()).observe(termHost);

// --- Maestro (#159) ----------------------------------------------------------
// The stage rearranges the same window: orchestra | code | impact, the chat
// and the sidebar out of the way. The inspector's file view, following the
// AI, is the code in the middle; nothing here is saved as a preference.
let maestroSaved = null; // the view before the stage, put back on leaving
let maestroSaid = null; // { source, text } in the balloon
let maestroSaidFull = false;
let backstageOpen = null; // the backstage chip opened in the consequences strip (#142)
let maestroOrderShown = null;
let maestroOrderTimer = null;
const maestroLines = new Map(); // sessionId → narration lines
const orchestraEl = document.getElementById('maestro-orchestra');
const impactEl = document.getElementById('maestro-impact');
const balloonEl = document.getElementById('maestro-balloon');
const orderEl = document.getElementById('maestro-order');
const consequencesEl = document.getElementById('maestro-consequences');

const musicianOf = (sessionId) => maestro.orchestra.find((musician) => musician.sessionId === sessionId) ?? null;

// --- the graph (#159, part 2): the focused músico's checkout ---------------
const graphs = new Map(); // root → graph | { unavailable }
const layouts = new Map(); // root → layout of that graph
const asked = new Set();
let graphView = { scale: 1, x: 0, y: 0, open: null, openedByZoom: false };
let graphRoot = null;
let centeredFor = null; // the músico the view was last centered for
let lastGraphSignature = null;
const graphStamps = new WeakMap();
let graphSerial = 0;

window.vizor.onMaestroGraph(({ root, graph }) => {
  graphs.set(root, graph);
  // Same files, same map; only the opened file's functions are laid out again.
  if (layouts.has(root)) layouts.get(root).openAreas = {};
  if (root === graphRoot) renderGraphColumn();
});

// The picture is redone only when files come or go: an edit changes the
// functions, not the map, so nothing jumps under the user.
const layoutKeys = new Map(); // root → the file list the layout was made for
function layoutOf(root) {
  const graph = graphs.get(root);
  if (!graph || graph.unavailable) return null;
  const key = graph.modules.map((module) => module.id).join('\n');
  if (!layouts.has(root) || layoutKeys.get(root) !== key) {
    layouts.set(root, layoutGraph(graph));
    layoutKeys.set(root, key);
  }
  return layouts.get(root);
}

function renderGraphColumn() {
  const musician = musicianOf(maestro.focusedId);
  const root = musician?.root ?? null;
  if (root !== graphRoot) {
    graphRoot = root;
    graphView = { scale: 1, x: 0, y: 0, open: null, openedByZoom: false };
  }
  if (!root) {
    impactEl.innerHTML = renderImpact(musician);
    return;
  }
  // Asked once: while the first build runs the answer is null, and the
  // maestro:graph push brings it (review I1: no request loop meanwhile).
  if (!graphs.has(root) && !asked.has(root)) {
    asked.add(root);
    window.vizor.maestroGraph(root).then((graph) => {
      if (!graph) return;
      graphs.set(root, graph);
      renderGraphColumn();
    });
  }
  const graph = graphs.get(root) ?? null;
  const impacts = (maestro.impacts ?? []).filter((impact) => impact.root === root);
  // A new focus: the view centers on the file it touched last.
  if (centeredFor !== maestro.focusedId && layoutOf(root)) {
    centeredFor = maestro.focusedId;
    const mine = impacts.find((impact) => impact.sessionId === maestro.focusedId);
    const target = Object.keys(mine?.modules ?? {}).find((id) => mine.modules[id] === 'touched') ?? Object.keys(mine?.modules ?? {})[0];
    const node = target && layoutOf(root).modules[target];
    // Not zoomed in, the whole map shows; zoomed, it follows the músico.
    if (node && graphView.scale > 1) graphView = { ...graphView, x: 500 - node.x * graphView.scale, y: 500 - node.y * graphView.scale };
  }
  // Redrawn only when something it shows changed (review I3: a 1.4 MB SVG on
  // every state push stalls big repos).
  const signature = [graph ? graphStamp(graph) : 'none', JSON.stringify(impacts), graphView.scale, graphView.x, graphView.y, graphView.open, graphView.selected].join('|');
  if (signature === lastGraphSignature && impactEl.firstChild) return;
  lastGraphSignature = signature;
  const svg = renderGraph({ graph, layout: layoutOf(root), view: graphView, impacts });
  impactEl.innerHTML = `<div class="maestro-title">área de impacto</div>${svg}${graph?.unavailable ? renderImpact(musician) : ''}`;
}

function graphStamp(graph) {
  if (!graphStamps.has(graph)) graphStamps.set(graph, ++graphSerial);
  return graphStamps.get(graph);
}

// Pointer position in the drawing's units (the SVG is 1000×1000, "meet").
function graphPoint(event) {
  const svg = impactEl.querySelector('svg.graph');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const side = Math.min(rect.width, rect.height);
  return {
    x: ((event.clientX - rect.left - (rect.width - side) / 2) * 1000) / side,
    y: ((event.clientY - rect.top - (rect.height - side) / 2) * 1000) / side,
  };
}

impactEl.addEventListener(
  'wheel',
  (event) => {
    const point = graphPoint(event);
    const layout = graphRoot && layoutOf(graphRoot);
    if (!point || !layout) return;
    event.preventDefault();
    const scale = Math.min(ZOOM_MAX, Math.max(0.5, graphView.scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    const ratio = scale / graphView.scale;
    graphView = { ...graphView, scale, x: point.x - (point.x - graphView.x) * ratio, y: point.y - (point.y - graphView.y) * ratio };
    // Zooming in far enough opens the file nearest the middle; back out, it closes.
    if (scale >= ZOOM_OPEN && !graphView.open) {
      let best = null;
      let bestDistance = Infinity;
      for (const [id, node] of Object.entries(layout.modules)) {
        const distance = Math.hypot(node.x * scale + graphView.x - 500, node.y * scale + graphView.y - 500);
        if (distance < bestDistance) [best, bestDistance] = [id, distance];
      }
      graphView = { ...graphView, open: best, openedByZoom: true };
    } else if (scale < ZOOM_OPEN && graphView.openedByZoom) graphView = { ...graphView, open: null, openedByZoom: false, selected: null };
    renderGraphColumn();
  },
  { passive: false },
);

let graphDrag = null;
impactEl.addEventListener('mousedown', (event) => {
  const point = graphPoint(event);
  if (point) graphDrag = { start: point, view: graphView, moved: false };
});
window.addEventListener('mousemove', (event) => {
  if (!graphDrag) return;
  // Released outside the window: the drag ends (review M7).
  if (!(event.buttons & 1)) {
    graphDrag = null;
    renderGraphColumn();
    return;
  }
  const point = graphPoint(event);
  if (!point) return;
  const dx = point.x - graphDrag.start.x;
  const dy = point.y - graphDrag.start.y;
  if (Math.hypot(dx, dy) > 4) graphDrag.moved = true;
  if (!graphDrag.moved) return;
  graphView = { ...graphDrag.view, x: graphDrag.view.x + dx, y: graphDrag.view.y + dy };
  // Dragging moves the drawing; it is not drawn again (review I3).
  impactEl.querySelector('svg.graph > g')?.setAttribute('transform', `translate(${graphView.x} ${graphView.y}) scale(${graphView.scale})`);
});
window.addEventListener('mouseup', (event) => {
  const drag = graphDrag;
  graphDrag = null;
  if (drag?.moved) renderGraphColumn(); // settle the drawing where the drag left it
  if (!drag || drag.moved) return;
  // A function circle can sit over another file: the element wins (review
  // M6). A click shows the name of what was clicked.
  const fn = event.target.closest('[data-function]');
  if (fn) {
    graphView = { ...graphView, selected: fn.dataset.function };
    renderGraphColumn();
    return;
  }
  // The opened file's backdrop: a click there keeps it open (only the name goes).
  if (event.target.closest('.open-backdrop')) {
    graphView = { ...graphView, selected: graphView.open };
    renderGraphColumn();
    return;
  }
  const point = graphPoint(event);
  const layout = graphRoot && layoutOf(graphRoot);
  if (!point || !layout) return;
  // A click on a file opens it (zooming in if needed); on the background, closes.
  const hit = moduleAt(layout, graphView, point.x, point.y);
  if (hit) {
    const node = layout.modules[hit];
    const scale = Math.max(graphView.scale, ZOOM_OPEN);
    graphView = { scale, x: 500 - node.x * scale, y: 500 - node.y * scale, open: hit, openedByZoom: false, selected: hit };
  } else graphView = { ...graphView, open: null, openedByZoom: false, selected: null };
  renderGraphColumn();
});

function renderMaestro() {
  if (!maestro.on) return;
  orchestraEl.innerHTML = renderOrchestra(maestro.orchestra, maestro.focusedId, maestro.orders ?? {});
  renderGraphColumn();
  consequencesEl.innerHTML =
    renderBackstage(maestro.backstage?.[maestro.focusedId], backstageOpen) + renderConsequences(maestroLines.get(maestro.focusedId) ?? []);
  balloonEl.innerHTML = renderBalloon(maestroSaid, musicianOf, { full: maestroSaidFull });
  orderEl.innerHTML = renderOrder(maestroOrderShown);
  placeBalloon();
}

// Over the line the AI is on: the selected edit's banner, when it is in view.
function placeBalloon() {
  const anchor = detailEl.querySelector('[data-banner][aria-current="true"]');
  const host = detailEl.getBoundingClientRect();
  const top = anchor ? anchor.getBoundingClientRect().top - host.top - balloonEl.offsetHeight - 6 : 0;
  balloonEl.style.top = `${detailEl.offsetTop}px`;
  balloonEl.style.transform = `translateY(${Math.max(0, Math.min(top, host.height - balloonEl.offsetHeight))}px)`;
}
detailEl.addEventListener('scroll', () => maestro.on && placeBalloon());

function focusMusicianView(sessionId) {
  // The last músico closed: the center empties instead of showing it (review I4).
  if (!sessionId) {
    selectedId = null;
    selectInspectorSession(null);
    render();
    return;
  }
  selectSession(sessionId);
  inspector = onFollow(inspector);
  fileView = null;
  refreshInspector({ scroll: true });
}

function enterMaestro() {
  maestroSaved = { mode: prefs.mode, width: prefs.width, chatHidden };
  document.body.dataset.maestro = 'true';
  // The code in the middle is the file view, wide; not saved as a preference.
  prefs.mode = 'arquivo';
  prefs.width = 'wide';
  chatHidden = true;
  document.body.dataset.chatHidden = 'true';
  focusMusicianView(maestro.focusedId);
  render();
  renderMaestro();
}

function leaveMaestro() {
  delete document.body.dataset.maestro;
  if (maestroSaved) {
    prefs.mode = maestroSaved.mode;
    prefs.width = maestroSaved.width;
    chatHidden = maestroSaved.chatHidden;
    document.body.dataset.chatHidden = String(chatHidden);
  }
  maestroSaved = null;
  render();
  loadFileView();
  requestAnimationFrame(fitActive);
}

function applyMaestro(next) {
  if (!next) return;
  const was = maestro;
  maestro = next;
  if (next.on && !was.on) enterMaestro();
  else if (!next.on && was.on) leaveMaestro();
  else if (next.on && next.focusedId !== was.focusedId) focusMusicianView(next.focusedId);
  renderMaestro();
}

window.vizor.onMaestroSay((say) => {
  maestroSaid = say;
  maestroSaidFull = false;
  renderMaestro();
});
window.vizor.onMaestroNarration(({ sessionId, text }) => {
  const lines = [...(maestroLines.get(sessionId) ?? []), text].slice(-20);
  maestroLines.set(sessionId, lines);
  renderMaestro();
});
window.vizor.onMaestroOrder((order) => {
  maestroOrderShown = order;
  clearInterval(maestroOrderTimer);
  // The countdown redraws its own strip only (review M5: not the whole stage).
  maestroOrderTimer = order ? setInterval(() => (orderEl.innerHTML = renderOrder(maestroOrderShown)), 250) : null;
  renderMaestro();
});

function setChatHidden(hidden) {
  chatHidden = hidden;
  document.body.dataset.chatHidden = String(hidden);
  // The code needs the room: an inspector folded away opens wide.
  if (hidden && prefs.width === 'collapsed') savePrefs({ width: 'wide' });
  render();
  if (!hidden) requestAnimationFrame(fitActive);
}

// What the voice asked of the workspace (main sends it, #161).
window.vizor.onVoice(({ action, file }) => {
  if (action === 'hide-chat') setChatHidden(true);
  else if (action === 'show-chat') setChatHidden(false);
  else if (action === 'show-diff') {
    if (prefs.width === 'collapsed') savePrefs({ width: 'compact' });
  } else if (action === 'open-file' && file) {
    const wanted = String(file).toLowerCase();
    const card = [...document.querySelectorAll('[data-card], [data-banner], [data-file]')].find((element) =>
      (element.dataset.file ?? element.textContent ?? '').toLowerCase().includes(wanted),
    );
    card?.click();
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (target.closest('[data-toggle-maestro]')) {
    window.vizor.setMaestro(!maestro.on);
    return;
  }
  const brand = target.closest('[data-action-menu]');
  if (brand) {
    const { left, bottom } = brand.getBoundingClientRect();
    window.vizor.openActionMenu({ left, bottom });
    return;
  }
  const musician = target.closest('[data-musician]');
  if (musician) {
    window.vizor.focusMusician(musician.dataset.musician);
    return;
  }
  const chip = target.closest('[data-backstage]');
  if (chip) {
    backstageOpen = backstageOpen === chip.dataset.backstage ? null : chip.dataset.backstage;
    renderMaestro();
    return;
  }
  if (target.closest('[data-balloon-more]')) {
    maestroSaidFull = true;
    renderMaestro();
    return;
  }
  if (target.closest('[data-toggle-chat]')) {
    setChatHidden(!chatHidden);
    return;
  }
  if (!newMenu.hidden && !target.closest('#new-menu') && !target.closest('[data-new-terminal]')) closeMenu();
  const newKind = target.closest('[data-new-kind]');
  if (newKind) {
    openNewTerminal(newKind.dataset.newKind);
    return;
  }
  const goTab = target.closest('[data-go-tab]');
  if (goTab) {
    closeMenu();
    focusNewTab(goTab.dataset.goTab);
    return;
  }
  const resume = target.closest('[data-resume]');
  if (resume) {
    if (!resume.disabled) openNewTerminal('resume', resume.dataset.resume);
    return;
  }
  const fold = target.closest('[data-fold]');
  if (fold) {
    folds[fold.dataset.fold] = fold.getAttribute('aria-expanded') !== 'true';
    saveFolds();
    sidebar.innerHTML = renderSidebar(lastTree, selectedId, selectedWorktree, folds);
    return;
  }
  if (target.closest('[data-bring]')) {
    const sessionId = selectedId;
    const result = await window.vizor.bringToVizor(sessionId);
    if (result?.error) {
      outsideStatus.set(sessionId, { value: { canBring: false, why: result.error }, at: Date.now() });
      renderTerminalArea();
      return;
    }
    outsideStatus.delete(sessionId);
    // The state listing the new tab usually lands before this reply: select
    // it now, or a later push would yank the focus mid-typing (review I-3).
    focusNewTab(result.id);
    return;
  }
  const commentButton = target.closest('[data-comment]');
  if (commentButton) {
    // A draft already typed follows to the newly picked change (#135).
    const draft = composer?.draft ?? '';
    const editId = commentButton.dataset.comment;
    const edit = inspectorTask?.edits.find((item) => item.id === editId) ?? null;
    composer = { editId, edit, draft, error: null };
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
    reportSelection();
    return;
  }
  const plus = target.closest('[data-new-terminal]');
  if (plus) {
    if (!newMenu.hidden) closeMenu();
    else if (selectedWorktree) openMenu(plus);
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
    selectInspectorSession(null);
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
  // In the Maestro a selection from anywhere (bubble, panel, voice) moves the
  // focus, so the code and the orchestra always show the same chat (review I5).
  if (maestro.on && sessionId !== maestro.focusedId && musicianOf(sessionId)) window.vizor.focusMusician(sessionId);
  pendingFocus = null; // a hand pick beats a request still waiting for the tree
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

// Main mutes notices for the session this focused window is showing — which
// is the one whose terminal tab is active when a tab was picked by hand
// (#96 review: a stale selection muted a session nobody was looking at).
function reportSelection() {
  const selected = selectedId ? findSession(selectedId)?.session : null;
  if (activeTab && selected?.ptyId !== activeTab) {
    let owner = null;
    for (const project of lastTree?.projects ?? [])
      for (const worktree of project.worktrees)
        for (const session of worktree.sessions) if (session.ptyId === activeTab) owner = session.id;
    window.vizor.reportSelection(owner);
    return;
  }
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

// --- Ctrl+K (core flow) ------------------------------------------------------
// The same actions as the voice, by keyboard. Ctrl+K is taken before the
// terminal sees it.
const commandBar = document.getElementById('command-bar');
const commandInput = document.getElementById('command-input');
const commandList = document.getElementById('command-list');
const commandToast = document.getElementById('command-toast');
let commandCatalog = null; // { issues, prs, error } once main answered
let commandShown = [];
let commandSelected = 0;
let commandToastTimer = null;

function treeSessions() {
  const placed = (lastTree?.projects ?? []).flatMap((project) => project.worktrees.flatMap((worktree) => worktree.sessions));
  return [...placed, ...(lastTree?.unplacedSessions ?? [])];
}

function commandChats() {
  return treeSessions().map((session) => {
    const musician = musicianOf(session.id);
    const name = session.name || 'chat';
    return { sessionId: session.id, name: musician ? `${musician.name} ${name}` : name, status: session.status };
  });
}

function refreshCommandList() {
  const items = buildCommands({
    issues: commandCatalog?.issues ?? [],
    prs: commandCatalog?.prs ?? [],
    issuesError: Boolean(commandCatalog?.error),
    issuesLoading: !commandCatalog,
    chats: commandChats(),
    plans,
    focusedId: planSessionId(),
    maestroOn: maestro.on,
  });
  commandShown = filterCommands(items, commandInput.value);
  commandSelected = Math.max(0, commandShown.findIndex((item) => !item.disabled));
  drawCommandList();
}

function drawCommandList() {
  commandList.innerHTML = renderCommandList(commandShown, commandSelected);
  commandList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function openCommandBar() {
  commandBar.hidden = false;
  commandInput.value = '';
  commandCatalog = null;
  refreshCommandList();
  commandInput.focus();
  window.vizor
    .commandCatalog()
    .catch(() => ({ issues: [], prs: [], error: true }))
    .then((catalog) => {
      commandCatalog = catalog;
      if (!commandBar.hidden) refreshCommandList();
    });
}

function closeCommandBar() {
  commandBar.hidden = true;
  if (!maestro.on) views.get(activeTab)?.term.focus();
}

function toast(text) {
  commandToast.textContent = text;
  commandToast.hidden = false;
  clearTimeout(commandToastTimer);
  commandToastTimer = setTimeout(() => (commandToast.hidden = true), 5000);
}

async function runCommandItem(item) {
  if (!item || item.disabled) return;
  closeCommandBar();
  const { action } = item;
  if (action.type === 'focus') {
    if (maestro.on && musicianOf(action.sessionId)) window.vizor.focusMusician(action.sessionId);
    else selectSession(action.sessionId);
    return;
  }
  if (action.type === 'approve' || action.type === 'open-pr') {
    const result = await window.vizor.planAction(action.sessionId, action.type === 'approve' ? 'approve' : 'pr');
    if (PLAN_NOTES[result]) toast(PLAN_NOTES[result]);
    return;
  }
  if (action.type === 'pick-issue') toast(`abrindo a #${action.number}…`);
  const result = await window.vizor.runCommand(action);
  if (result?.error) toast(result.error);
  else if (action.type === 'pick-issue') commandToast.hidden = true;
}

window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    event.stopPropagation();
    if (commandBar.hidden) openCommandBar();
    else closeCommandBar();
  },
  true,
);

commandInput.addEventListener('input', refreshCommandList);
commandInput.addEventListener('blur', () => {
  if (commandBarOpen()) queueMicrotask(() => commandBarOpen() && commandInput.focus());
});
commandInput.addEventListener('keydown', (event) => {
  const step = (delta) => {
    if (!commandShown.length) return;
    let next = commandSelected;
    for (let index = 0; index < commandShown.length; index++) {
      next = (next + delta + commandShown.length) % commandShown.length;
      if (!commandShown[next].disabled) break;
    }
    commandSelected = next;
    drawCommandList();
  };
  if (event.key === 'ArrowDown') step(1);
  else if (event.key === 'ArrowUp') step(-1);
  else if (event.key === 'Enter') runCommandItem(commandShown[commandSelected]);
  else if (event.key === 'Escape') closeCommandBar();
  else return;
  event.preventDefault();
});
commandList.addEventListener('mousedown', (event) => {
  event.preventDefault();
  const row = event.target.closest('[data-command-index]');
  if (row) runCommandItem(commandShown[Number(row.dataset.commandIndex)]);
});
document.addEventListener('mousedown', (event) => {
  if (!commandBar.hidden && !commandBar.contains(event.target)) closeCommandBar();
});
