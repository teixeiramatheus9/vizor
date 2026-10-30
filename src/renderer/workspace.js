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
import { createPlanController } from './work/plan-controller.js';
import { averageColor, nudgeColor } from './project-accent.js';
import { buildCommands, createConfirmGate, filterCommands, renderCommandList } from './command-bar.js';
import { renderBackstage, renderBalloon, renderConsequences, renderOrder } from './maestro-view.js';
import { createReviewController } from './review/review-controller.js';
import { TOP_TABS, normalizeTopTab, renderTopTabs } from './shell/top-tabs.js';
import { renderStatusBar, limitsLabel } from './shell/status-bar.js';
import { renderLimitsPanel, fiveHourShares, liveKey } from './limits/limits-panel.js';
import { keyAction, renderShortcuts } from './shell/shortcuts.js';
import { createAgentsController } from './agents/agents-controller.js';
import { createGithubController } from './github/github-controller.js';
import { createAutomationsController } from './automations/automations-controller.js';
import { nextLabel } from './automations/automations-view.js';

const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
const tabsBar = document.getElementById('tabs');
const termHost = document.getElementById('term-host');
const placeholder = document.getElementById('term-placeholder');
const newMenu = document.getElementById('new-menu');

let lastTree = null;
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
let agentSessionList = []; // the registry's sessions, for the card's pending question
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
  showDrawer();
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
  showDrawer();
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
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: cssVar('--ws-panel'), foreground: cssVar('--text'), cursor: cssVar('--accent') },
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

// The terminal lives in a drawer under the review: closed, nothing is
// fitted (a zero-size fit would shrink the pty) and nothing takes the keys.
const drawerEl = document.getElementById('terminal-drawer');
// The drawer belongs to the Workspace view: elsewhere it is display:none, so
// nothing is fitted (a zero-size fit would shrink the pty) and no key goes there.
let topTab = 'workspace';
const drawerShown = () => topTab === 'workspace' && drawerEl.classList.contains('open');
// A state push must not pull the keys out of the composer or the file filter.
const typingElsewhere = () => document.activeElement?.matches?.('input, textarea, select') && !drawerEl.contains(document.activeElement);

function fitActive() {
  const view = views.get(activeTab);
  if (!view || termHost.hidden || !drawerShown()) return;
  view.fit.fit();
  window.vizor.resizeTerminal(activeTab, view.term.cols, view.term.rows);
}

function worktreeTerminals() {
  return terminals.filter((terminal) => terminal.cwd === selectedWorktree);
}

async function renderTerminalArea() {
  review.setContext(reviewContext());
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
  if (!commandBarOpen() && drawerShown() && !typingElsewhere()) view.term.focus();
}

// The orchestra lives in the sidebar now: a dot of each músico's color.
function musicianMarks() {
  if (!maestro.on) return {};
  return Object.fromEntries(maestro.orchestra.map((musician) => [musician.sessionId, { color: musician.color, name: musician.name }]));
}

// Project avatars: main sends the data: URI per project root; the accent is
// the avatar's average colour, read once through a tiny offscreen canvas.
let avatarUris = {};
const accents = new Map(); // data URI -> hex | null

function accentOf(uri) {
  if (accents.has(uri)) return accents.get(uri);
  accents.set(uri, null);
  const image = new Image();
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, 16, 16);
      const average = averageColor(context.getImageData(0, 0, 16, 16).data);
      if (average) {
        accents.set(uri, nudgeColor(...average));
        renderSidebarOnly();
        agents.refresh();
        github.refresh();
        automations.refresh();
      }
    } catch {
      // no canvas readback: the monogram colour stays
    }
  };
  image.src = uri;
  return null;
}

// The Agentes tab: what each project looks like on its cards and filter chips.
function agentProjects() {
  return Object.fromEntries(
    (lastTree?.projects ?? []).map((project) => {
      const uri = avatarUris[project.root] ?? null;
      return [project.root, { name: project.name, uri, accent: uri ? accentOf(uri) : null }];
    }),
  );
}

function avatarMarks() {
  return Object.fromEntries(
    Object.entries(avatarUris).map(([root, uri]) => [root, { uri, accent: uri ? accentOf(uri) : null }]),
  );
}

function renderSidebarOnly() {
  sidebar.innerHTML = renderSidebar(lastTree, selectedId, selectedWorktree, folds, musicianMarks(), avatarMarks());
}

const topTabsEl = document.getElementById('top-tabs');
function drawTopTabs() {
  const html = renderTopTabs(topTab, { waiting: agents.waitingCount() });
  if (topTabsEl.innerHTML !== html) topTabsEl.innerHTML = html;
}

// The bottom line follows the state push (which also carries each token spend):
// no timer. A click on the agents part opens the Agentes tab.
const statusBarEl = document.getElementById('status-bar');
let statusTokens = { used: 0, cap: 0 };
let nextAutomationAt = null; // from the state push; the status line's "próxima automação"
function drawStatusBar() {
  refreshLimitsExpiry();
  const html = renderStatusBar({ tokens: statusTokens, agents: agents.counts(), limits: limitsLabel(limitsSnapshot, Date.now()), nextAutomation: nextAutomationAt != null ? { at: nextLabel(nextAutomationAt, Date.now()) } : null });
  if (statusBarEl.innerHTML !== html) statusBarEl.innerHTML = html;
  scheduleStatusClock();
}
// "próxima automação" is a clock time: redraw at the next minute, once, only while visible.
let statusClock = null;
function scheduleStatusClock() {
  clearTimeout(statusClock);
  statusClock = null;
  if (document.hidden || nextAutomationAt == null) return;
  statusClock = setTimeout(() => {
    statusClock = null;
    drawStatusBar();
  }, 60000 - (Date.now() % 60000) + 50);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) drawStatusBar();
  else scheduleStatusClock();
});
// The limits panel: the status-bar item toggles it; Esc or a click outside closes it.
let limitsSnapshot = null;
const limitsPopover = document.getElementById('limits-popover');
const chatNameOf = (sessionId, cwd) => {
  const session = agentSessionList.find((item) => item.id === sessionId);
  const name = session?.alias ?? session?.title ?? session?.promptPreview ?? session?.projectName;
  return name || String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || 'chat';
};
function drawLimitsPanel() {
  limitsPopover.innerHTML = renderLimitsPanel(limitsSnapshot ?? { windows: {}, shares: {}, settings: {} }, Date.now(), { nameOf: chatNameOf });
}
function setLimitsPanel(open) {
  limitsPopover.hidden = !open;
  if (open) drawLimitsPanel();
}
// A window that passed its reset drops out (and its card shares) on the next redraw, no push needed.
let limitsLive = '';
function refreshLimitsExpiry() {
  const key = liveKey(limitsSnapshot, Date.now());
  if (key === limitsLive) return;
  limitsLive = key;
  agents.setShares(fiveHourShares(limitsSnapshot, Date.now()));
  if (!limitsPopover.hidden) drawLimitsPanel();
}
function applyLimits(snapshot) {
  limitsSnapshot = snapshot;
  limitsLive = liveKey(snapshot, Date.now());
  agents.setShares(fiveHourShares(snapshot, Date.now()));
  drawStatusBar();
  if (!limitsPopover.hidden) drawLimitsPanel();
}
window.vizor.limitsState?.().then((snapshot) => snapshot && applyLimits(snapshot)).catch(() => {});
window.vizor.onLimitsChanged?.(applyLimits);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || limitsPopover.hidden) return;
  setLimitsPanel(false);
  statusBarEl.querySelector('[data-limits-toggle]')?.focus();
});
document.addEventListener('mousedown', (event) => {
  if (!limitsPopover.hidden && !limitsPopover.contains(event.target) && !event.target.closest('[data-limits-toggle]')) setLimitsPanel(false);
});
statusBarEl.addEventListener('click', (event) => {
  if (event.target.closest('[data-top-tab]')) setTopTab('agents');
  else if (event.target.closest('[data-limits-toggle]')) setLimitsPanel(limitsPopover.hidden);
});

// Switching only shows and hides views: no pty is touched. Coming back to the
// Workspace refits the terminal, which could not be measured while hidden.
function setTopTab(next, { save = true } = {}) {
  next = normalizeTopTab(next);
  if (save) userSwitchedTab = true;
  if (next === topTab) return;
  topTab = next;
  for (const tab of TOP_TABS) document.getElementById(`view-${tab.id}`).hidden = tab.id !== next;
  drawTopTabs();
  syncAgentsVisibility();
  if (save) window.vizor.setPrefs({ topTab: next }).catch(() => {});
  if (next === 'workspace') {
    fitActive();
    markLooking();
    if (!commandBarOpen() && drawerShown() && !typingElsewhere()) views.get(activeTab)?.term.focus();
  }
}
// The kanban draws and schedules its 30-min cut only while it is on screen.
const agents = createAgentsController({
  el: document.getElementById('view-agents'),
  api: window.vizor,
  projects: agentProjects,
  // A card click: the Workspace tab, the chat selected, the drawer open, the terminal focused.
  openSession: (sessionId) => {
    setTopTab('workspace');
    selectSession(sessionId);
  },
  // A running automação's card: its history in the Automações tab.
  openAutomation: (id) => {
    setTopTab('automations');
    automations.showHistory(id);
  },
});
// The GitHub tab reads and keeps its 5-min refresh only while it is on screen.
const github = createGithubController({
  el: document.getElementById('view-github'),
  api: window.vizor,
  projects: agentProjects,
  // "Puxar"/"Revisar" open a new chat: it lives in the Workspace.
  openWorkspace: () => setTopTab('workspace'),
  notify: (text) => toast(text),
});
// The Automações tab reads and keeps its 1 s running clock only while on screen.
const automations = createAutomationsController({
  el: document.getElementById('view-automations'),
  regions: { top: document.getElementById('au-top'), list: document.getElementById('au-list'), side: document.getElementById('au-side') },
  api: window.vizor,
  projects: agentProjects,
  // "abrir na revisão": the Workspace tab on the automação's worktree.
  openReview: (worktree) => {
    setTopTab('workspace');
    selectedWorktree = worktree;
    selectedId = null;
    selectInspectorSession(null);
    render();
    reportSelection();
  },
  notify: (text) => toast(text),
});
window.vizor.onAutomationsChanged((next) => {
  automations.setState(next);
  nextAutomationAt = next?.nextAt ?? null;
  drawStatusBar();
});
// The command bar and the first visit know the automações from the start.
automations.load();
const syncGithubVisibility = () => github.setVisible(topTab === 'github' && !document.hidden);
const syncAgentsVisibility = () => {
  agents.setVisible(topTab === 'agents' && !document.hidden);
  automations.setVisible(topTab === 'automations' && !document.hidden);
  syncGithubVisibility();
};
document.addEventListener('visibilitychange', syncAgentsVisibility);

topTabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-top-tab]');
  if (button) setTopTab(button.dataset.topTab);
});

function render() {
  if (!lastTree) return;
  topbar.innerHTML = renderTopBar(lastTree, { voice: voiceInfo, maestro: maestro.on, extra: agents.automationCounts() });
  drawTopTabs();
  renderSidebarOnly();
  renderTerminalArea();
}

// --- the review screen --------------------------------------------------
// The workspace is a worktree: the selected session's, else the one the
// active terminal runs in (the deepest worktree holding its folder).
function reviewContext() {
  const worktrees = (lastTree?.projects ?? []).flatMap((project) => project.worktrees);
  const selection = selectedId ? findSession(selectedId) : null;
  let worktree = selection?.worktree ?? null;
  if (!worktree && selectedWorktree) {
    worktree = worktrees
      .filter((item) => selectedWorktree === item.path || selectedWorktree.startsWith(`${item.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  }
  if (!worktree) return { worktree: null, sessions: [], agentId: null };
  const sessions = worktree.sessions.map((session) => ({ id: session.id, label: session.name || 'chat' }));
  const own = (id) => (sessions.some((session) => session.id === id) ? id : null);
  const agentId = own(selectedId) ?? own(worktree.sessions.find((session) => session.ptyId && session.ptyId === activeTab)?.id);
  return { worktree: worktree.path, sessions, agentId };
}

const review = createReviewController({
  api: window.vizor,
  notify: (text) => toast(text),
  onDrawerChange: (open) => {
    requestAnimationFrame(fitActive);
    if (open) {
      if (!commandBarOpen()) views.get(activeTab)?.term.focus();
    } else if (drawerEl.contains(document.activeElement)) document.activeElement.blur();
  },
});

// A terminal the dev just asked for has to be seen.
const showDrawer = () => review.setDrawer(true);


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
const planCard = createPlanController({
  el: planCardEl,
  api: window.vizor,
  sessionId: planSessionId,
  getSession: (id) => agentSessionList.find((session) => session.id === id) ?? null,
  plans: () => plans,
  onStepDiff: (n, task) => review.openStep(n, task ?? {}),
  // The review opens the file at its diff; the line is not scrolled to yet.
  onOpenFile: (file) => review.showFile(file),
});
const renderPlanCard = () => planCard.render();
window.vizor.onTaskChanged(() => planCard.refresh());

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
  if (!userSwitchedTab) setTopTab(saved.topTab, { save: false });
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
let guardShown = 0;
function renderGuardAsks(asks = []) {
  // The questions live in the drawer: a new one opens it, or nobody sees it.
  if (asks.length > guardShown) showDrawer();
  guardShown = asks.length;
  guardHost.hidden = asks.length === 0;
  guardHost.innerHTML = asks.map(renderGuardCard).join('');
}
guardHost.addEventListener('click', (event) => {
  const button = event.target.closest('[data-guard-choice]');
  if (!button) return;
  button.closest('.guard-card')?.classList.add('answered');
  window.vizor.answerGuard(button.dataset.guardId, button.dataset.guardChoice);
});

window.vizor.onState(({ tree, sessions: agentSessions, terminals: list, activeTerminal, theme, palette, density, guardAsks, voice, maestro: stage, plans: planState, avatars, tokens, automationRuns, nextAutomationAt: nextAt }) => {
  if (avatars) avatarUris = avatars;
  plans = planState ?? {};
  agentSessionList = agentSessions ?? [];
  renderGuardAsks(guardAsks);
  voiceInfo = voice ?? null;
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  document.body.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
  lastTree = tree;
  agents.setState({ sessions: agentSessions, plans, guardAsks, automationRuns });
  nextAutomationAt = nextAt ?? null;
  if (tokens) statusTokens = tokens;
  drawStatusBar();
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
  markLooking();
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
// A layer over the review screen, with no layout of its own: the
// orchestra is the dots in the sidebar, the impact is the Impacto tab, the
// balloon and the held order float over the tab in front, and the
// consequences and the backstage fold into the Resumo.
let maestroSaved = null; // the tab and the drawer before the stage, put back on leaving
let maestroSaid = null; // { source, text } in the balloon
let maestroSaidFull = false;
let backstageOpen = null; // the backstage chip opened in the consequences strip (#142)
let maestroOrderShown = null;
let maestroOrderTimer = null;
const maestroLines = new Map(); // sessionId → narration lines
const reviewBody = document.getElementById('review-body');
const balloonEl = document.getElementById('maestro-balloon');
const orderEl = document.getElementById('maestro-order');
const consequencesEl = document.getElementById('maestro-consequences');
const backstageEl = document.getElementById('summary-backstage');

const musicianOf = (sessionId) => maestro.orchestra.find((musician) => musician.sessionId === sessionId) ?? null;

function renderMaestro() {
  if (!maestro.on) {
    backstageEl.hidden = true;
    return;
  }
  const lines = maestroLines.get(maestro.focusedId) ?? [];
  const backstage = renderBackstage(maestro.backstage?.[maestro.focusedId], backstageOpen);
  consequencesEl.innerHTML = backstage + (lines.length ? renderConsequences(lines) : '');
  backstageEl.hidden = !consequencesEl.innerHTML;
  balloonEl.innerHTML = renderBalloon(maestroSaid, musicianOf, { full: maestroSaidFull });
  orderEl.innerHTML = renderOrder(maestroOrderShown);
  placeBalloon();
}

// Over the line the AI is on (the selected edit's banner, in Ao vivo), else
// at the top of the tab in front.
function placeBalloon() {
  const anchor = review.tab() === 'live' ? detailEl.querySelector('[data-banner][aria-current="true"]') : null;
  const host = reviewBody.getBoundingClientRect();
  const top = anchor ? anchor.getBoundingClientRect().top - host.top - balloonEl.offsetHeight - 6 : 8;
  balloonEl.style.transform = `translateY(${Math.max(0, Math.min(top, host.height - balloonEl.offsetHeight))}px)`;
}
detailEl.addEventListener('scroll', () => maestro.on && placeBalloon());

// Following the músico in focus selects its worktree and session in the
// sidebar; the drawer stays as the dev left it.
function focusMusicianView(sessionId) {
  // The last músico closed: the center empties instead of showing it (review I4).
  if (!sessionId) {
    selectedId = null;
    selectInspectorSession(null);
    render();
    return;
  }
  selectSession(sessionId, { openDrawer: false });
  inspector = onFollow(inspector);
  fileView = null;
  refreshInspector({ scroll: true });
}

// The stage shows the code as the AI writes it: Ao vivo, following.
function enterMaestro() {
  maestroSaved = review.saveView();
  document.body.dataset.maestro = 'true';
  review.setTab('live', { persist: false, pin: true });
  focusMusicianView(maestro.focusedId);
  render();
  renderMaestro();
}

function leaveMaestro() {
  delete document.body.dataset.maestro;
  review.restoreView(maestroSaved);
  maestroSaved = null;
  render();
  renderMaestro();
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

// What the voice asked of the workspace (main sends it, #161).
// "Esconde o chat" folds the terminal drawer; the code is the review above it.
window.vizor.onVoice(({ action, file }) => {
  if (action === 'hide-chat') review.setDrawer(false);
  else if (action === 'show-chat') review.setDrawer(true);
  else if (action === 'show-diff') {
    review.setTab('live');
    if (prefs.width === 'collapsed') savePrefs({ width: 'compact' });
  } else if (action === 'open-file' && file) {
    review.setTab('live');
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
  if (target.closest('[data-toggle-drawer]')) {
    review.toggleDrawer();
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
    renderSidebarOnly();
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
// openDrawer: a chat picked by hand (sidebar, Ctrl+K, the bubble) shows its
// terminal; the Maestro following its músico leaves the drawer alone.
function selectSession(sessionId, { openDrawer = true } = {}) {
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
  // Outside chats too: their "trazer pro Vizor" lives in the drawer.
  if (openDrawer) showDrawer();
  render();
  reportSelection();
}

// Main mutes notices for the session this focused window is showing — which
// is the one whose terminal tab is active when a tab was picked by hand
// (#96 review: a stale selection muted a session nobody was looking at).
function shownSessionId() {
  const selected = selectedId ? findSession(selectedId)?.session : null;
  if (activeTab && selected?.ptyId !== activeTab) {
    let owner = null;
    for (const project of lastTree?.projects ?? [])
      for (const worktree of project.worktrees)
        for (const session of worktree.sessions) if (session.ptyId === activeTab) owner = session.id;
    return owner;
  }
  return selectedId;
}

// A finished turn counts as seen once its terminal is in front in a focused window.
function markLooking() {
  if (topTab !== 'workspace' || !document.hasFocus() || !drawerShown()) return;
  const sessionId = shownSessionId();
  if (sessionId) agents.lookingAt(sessionId);
}

function reportSelection() {
  window.vizor.reportSelection(shownSessionId());
  markLooking();
}

window.addEventListener('focus', reportSelection);

// A request that lands before the tree knows the session waits for it.
let pendingFocus = null;
window.vizor.onFocusSession(({ sessionId }) => {
  // The chat lives in the Workspace tab (bubble, balloon, panel card, Maestro,
  // voice, a pulled issue): show it, and let this beat the saved tab still loading.
  if (sessionId) setTopTab('workspace');
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
    issuesError: Boolean(commandCatalog?.issuesError ?? commandCatalog?.error),
    prsError: Boolean(commandCatalog?.prsError),
    issuesLoading: !commandCatalog,
    chats: commandChats(),
    plans,
    tasks: Object.fromEntries(commandChats().map((chat) => [chat.sessionId, planCard.taskOf(chat.sessionId)]).filter(([, task]) => task)),
    blocked: agentSessionList.filter((session) => session.blocksTyping).map((session) => session.id),
    focusedId: planSessionId(),
    maestroOn: maestro.on,
    automations: automations.list(),
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
  if (!maestro.on && topTab === 'workspace') views.get(activeTab)?.term.focus();
}

function toast(text) {
  commandToast.textContent = text;
  commandToast.hidden = false;
  clearTimeout(commandToastTimer);
  commandToastTimer = setTimeout(() => (commandToast.hidden = true), 5000);
}

const unlockGate = createConfirmGate();
async function runCommandItem(item) {
  if (!item || item.disabled) return;
  const { action } = item;
  // Unlocking the tests asks twice, like the card: the bar stays open meanwhile.
  if (action.type === 'task' && action.name === 'unlockTests') {
    if (unlockGate.press(item.id) === 'armed') return toast('Enter de novo pra destravar os testes');
  } else unlockGate.reset();
  // Everything but "ir pra <tela>" acts on the Workspace (drawer, chat, plan):
  // show it first so the user sees the result.
  const onAutomations = action.type === 'new-automation' || action.type === 'run-automation';
  setTopTab(action.type === 'goto-tab' ? action.tab : onAutomations ? 'automations' : 'workspace');
  closeCommandBar();
  if (action.type === 'goto-tab') return;
  if (action.type === 'new-automation') return automations.startNew();
  if (action.type === 'run-automation') return automations.runNow(action.id);
  if (action.type === 'focus') {
    showDrawer();
    if (maestro.on && musicianOf(action.sessionId)) window.vizor.focusMusician(action.sessionId);
    else selectSession(action.sessionId);
    return;
  }
  if (action.type === 'task') {
    // "Sua vez" only reads; the rest are the card's own actions.
    if (action.name === 'myTurn') {
      const task = planCard.taskOf(action.sessionId);
      const todo = task?.devTodos?.[0];
      toast(todo ? `Sua vez: ${todo.file}:${todo.line}` : 'Sua vez no passo [dev] atual');
      return;
    }
    const result = await window.vizor.task(action.sessionId, action.name);
    const note = result?.error ?? (result?.delivery && !['sent', 'pasted'].includes(result.delivery) ? PLAN_NOTES[result.delivery] ?? String(result.delivery) : null);
    if (note) toast(note);
    planCard.refresh(action.sessionId);
    return;
  }
  if (action.type === 'approve' || action.type === 'open-pr') {
    const result = await window.vizor.planAction(action.sessionId, action.type === 'approve' ? 'approve' : 'pr');
    const note = PLAN_NOTES[result] ?? result?.error;
    if (note) toast(note);
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

// Ctrl+1..3 switch the top tab, caught before xterm like Ctrl+K. Bare 1..4
// (review tabs) and "?" (help) only count outside the terminal and text fields.
const helpEl = document.getElementById('shortcuts-help');
let userSwitchedTab = false; // a Ctrl+digit or click beats the saved tab still loading
const REVIEW_TAB_IDS = ['summary', 'changes', 'impact', 'live'];
function toggleHelp(show = helpEl.hidden) {
  if (show) helpEl.innerHTML = renderShortcuts();
  helpEl.hidden = !show;
  if (show) {
    helpEl.tabIndex = -1;
    helpEl.focus();
  } else if (topTab === 'workspace' && !commandBarOpen() && !typingElsewhere()) views.get(activeTab)?.term.focus();
}
window.addEventListener(
  'keydown',
  (event) => {
    if (commandBarOpen()) return;
    const target = event.target instanceof Element ? event.target : null;
    const focusInTerminal = Boolean(target?.closest('#terminal-drawer'));
    const focusInField = focusInTerminal || Boolean(target?.closest('input, textarea, select, [contenteditable]'));
    if (!helpEl.hidden) {
      // Esc closes the help, except in the terminal where Esc is the shell's:
      // there the help closes on the next key that is not a modifier.
      if (event.key === 'Escape' && !focusInTerminal) {
        event.preventDefault();
        event.stopPropagation();
        toggleHelp(false);
        return;
      }
      if (focusInTerminal && !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) toggleHelp(false);
    }
    const action = keyAction(event, { focusInTerminal, focusInField, composing: event.isComposing });
    if (!action) return;
    // Bare digits belong to the Workspace's review tabs; elsewhere they stay free.
    if (action.inner && topTab !== 'workspace') return;
    event.preventDefault();
    event.stopPropagation();
    if (action.top) setTopTab(TOP_TABS[action.top - 1].id);
    else if (action.inner) review.setTab(REVIEW_TAB_IDS[action.inner - 1]);
    else if (action.help) toggleHelp();
  },
  true,
);

// Ctrl+` opens and closes the terminal drawer, before xterm sees it.
window.addEventListener(
  'keydown',
  (event) => {
    if (!event.ctrlKey || event.shiftKey || event.altKey || (event.key !== '`' && event.code !== 'Backquote')) return;
    event.preventDefault();
    event.stopPropagation();
    if (topTab === 'workspace') review.toggleDrawer();
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
