// The review screen's wiring: tabs, the terminal drawer, the composer, and the
// data each visible tab asks main for. workspace.js owns the sessions and the
// terminals; this owns what sits around them. The helpers at the top are pure
// (vitest checks them); createReviewController touches the DOM.
import { escapeHtml } from '../workspace-view.js';
import { REVIEW_TABS, renderReviewTabs } from './tabs-view.js';
import { renderSummary } from './summary-view.js';
import { renderFileDiff, renderFileList } from './diff-view.js';
import { layoutSlice, renderSlice, renderSliceStatus } from './slice-view.js';
import { renderComposer } from './composer-view.js';

// Same text as EXPLAIN_TEXT in src/main/review/compose.js (main modules cannot
// be imported here); keep the two in step.
export const EXPLAIN_TEXT = 'Explique esse trecho e por que foi feito assim.';

export const DRAWER_MIN = 120;
export const DRAWER_MAX_SHARE = 0.7;
export const DRAWER_DEFAULT = 300;
const TAB_IDS = new Set(REVIEW_TABS.map(([id]) => id));

// The drawer's top edge: from 120 px up to 70% of the review column.
export function clampDrawerHeight(height, total) {
  const max = Math.max(DRAWER_MIN, Math.floor(total * DRAWER_MAX_SHARE));
  return Math.round(Math.min(max, Math.max(DRAWER_MIN, Number(height) || DRAWER_DEFAULT)));
}

// What the dev asked for, as the summary shows it.
export function requestText(request) {
  if (!request) return '';
  if (request.kind === 'issue') return [`#${request.number} ${request.title ?? ''}`.trim(), request.body ?? ''].filter(Boolean).join('\n\n');
  return request.text ?? '';
}

export const hunkContext = (path, hunk) => ({ kind: 'hunk', path, newStart: hunk.newStart, newLines: hunk.newLines });

export function nodeContext(node) {
  const path = node.files?.[0] ?? '';
  // A module node is its file: "src/a.js (src/a.js)" says nothing twice.
  if (!node.range && String(node.label ?? node.id) === path) return { kind: 'file', path };
  const context = { kind: 'node', label: String(node.label ?? node.id), path: node.files?.[0] ?? '' };
  if (node.range) Object.assign(context, { startLine: node.range.startLine, endLine: node.range.endLine });
  return context;
}

// Does the hunk touch these lines of the new file? A pure deletion sits at newStart.
export function hunkInRange(hunk, range) {
  if (!range) return true;
  const end = hunk.newStart + Math.max(1, hunk.newLines) - 1;
  return hunk.newStart <= range.endLine && end >= range.startLine;
}

// The node a hunk lights in Impacto: the smallest function around it, else its file.
export function nodeOfHunk(slice, path, hunk) {
  let best = null;
  for (const node of slice?.nodes ?? []) {
    if (!node.files?.includes(path)) continue;
    if (node.range) {
      if (!hunkInRange(hunk, node.range)) continue;
      if (!best?.range || node.range.endLine - node.range.startLine < best.range.endLine - best.range.startLine) best = node;
    } else if (!best) best = node;
  }
  return best?.id ?? null;
}

// Who the composer writes to: the dev's pick while it is still there, else the agent.
export function composerTarget(sessions, pickedId, agentId) {
  const list = sessions ?? [];
  const chosen = list.find((s) => s.id === pickedId) ?? list.find((s) => s.id === agentId) ?? list[0] ?? null;
  return { sessionId: chosen?.id ?? null, sessionLabel: chosen?.label ?? 'nenhum chat neste worktree', sessions: list };
}

// A verdict item leads to its detail; tsc and the tests run on a click.
export function verdictAction(key) {
  if (key === 'tsc' || key === 'tests') return { verify: key };
  if (key === 'untested') return { tab: 'impact' };
  return { tab: 'changes' };
}

export function createReviewController({ api, doc = document, notify = () => {}, onDrawerChange = () => {} }) {
  const $ = (id) => doc.getElementById(id);
  const tabsEl = $('review-tabs');
  const reviewEl = $('review');
  const panels = Object.fromEntries([...doc.querySelectorAll('[data-review-panel]')].map((el) => [el.dataset.reviewPanel, el]));
  const summaryHead = $('summary-head');
  const filterInput = $('changes-filter');
  const nodeFilterEl = $('changes-node-filter');
  const filesEl = $('changes-files');
  const diffEl = $('changes-diff');
  const impactEl = $('impact-body');
  const impactTools = $('impact-tools');
  const drawerEl = $('terminal-drawer');
  const composerEl = $('review-composer');

  let worktree = null;
  let sessions = [];
  let agentId = null;
  let tab = 'summary';
  let pinnedTab = false; // the Maestro holds the tab: a worktree's prefs do not move it
  let drawer = { open: true, height: DRAWER_DEFAULT };
  // Explicit opens/closes, counted: one since the last setContext (a sidebar
  // click, Ctrl+K: showDrawer() and then render()) or while the prefs load
  // beats the worktree's saved drawer.
  let drawerSets = 0;
  let drawerSetsSeen = 0;
  let prefsSerial = 0;
  const serial = { summary: 0, file: 0, slice: 0 };
  let summary = null;
  let selectedPath = null;
  let fileView = null;
  let selectedHunk = null; // { id, path, newStart, newLines }
  let pendingReject = null;
  const forceOpen = new Set();
  const progress = {}; // path → { approved, total }, from the files opened
  let filter = '';
  let nodeFilter = null; // { label, files, range } from a click in Impacto
  let slice = null; // the last { status, slice?, reason? }
  let selectedNode = null;
  let expanded = [];
  let showHidden = false;
  let composer = { context: null, draft: '', error: '', pickedId: null, sending: false };
  let composerSignature = null;

  const persist = (set) => {
    if (worktree) api.reviewPrefs(worktree, set).catch(() => {});
  };

  // --- tabs -----------------------------------------------------------------
  function showTab() {
    tabsEl.innerHTML = renderReviewTabs(tab);
    for (const [id, el] of Object.entries(panels)) el.hidden = id !== tab;
    doc.body.dataset.reviewTab = tab;
  }

  function setTab(next, { persist: save = true, pin } = {}) {
    if (!TAB_IDS.has(next)) return;
    if (pin !== undefined) pinnedTab = pin;
    const changed = next !== tab;
    tab = next;
    showTab();
    if (save) persist({ tab });
    if (changed) refreshVisible();
  }

  // Only the visible tab asks main for anything.
  function refreshVisible() {
    if (!worktree) {
      drawEmpty();
      return;
    }
    if (tab === 'summary' || tab === 'changes') loadSummary();
    if (tab === 'changes' && selectedPath) loadFile();
    if (tab === 'impact') loadSlice();
  }

  function drawEmpty() {
    summaryHead.innerHTML = '<p class="review-note">Escolha um worktree ou uma sessão na barra da esquerda.</p>';
    filesEl.innerHTML = '';
    diffEl.innerHTML = '';
    impactEl.innerHTML = '';
    impactTools.innerHTML = '';
  }

  // --- the drawer -------------------------------------------------------------
  // notify: false when only the height may have moved (the ResizeObserver on
  // the terminal refits it); a state change also focuses or blurs it.
  function applyDrawer({ notify = true } = {}) {
    drawerEl.classList.toggle('open', drawer.open);
    drawerEl.style.height = drawer.open ? `${clampDrawerHeight(drawer.height, reviewEl.clientHeight || 600)}px` : '';
    const toggle = drawerEl.querySelector('[data-toggle-drawer]');
    if (toggle) {
      toggle.textContent = drawer.open ? '▾' : '▴';
      toggle.title = drawer.open ? 'Fechar o terminal (Ctrl+`)' : 'Abrir o terminal (Ctrl+`)';
    }
    if (notify) onDrawerChange(drawer.open);
  }

  // Closing only hides it: every pty keeps running in main.
  function setDrawer(open, { persist: save = true } = {}) {
    drawerSets++;
    if (drawer.open === open) return;
    drawer.open = open;
    applyDrawer();
    if (save) persist({ drawerOpen: open });
  }

  let drag = null;
  drawerEl.addEventListener('mousedown', (event) => {
    if (!drawer.open || !event.target.closest('#drawer-bar') || event.target.closest('button')) return;
    event.preventDefault();
    drag = { top: reviewEl.getBoundingClientRect().bottom, total: reviewEl.clientHeight };
    doc.body.classList.add('resizing-drawer');
  });
  doc.defaultView.addEventListener('mousemove', (event) => {
    if (!drag) return;
    if (!(event.buttons & 1)) return endDrag();
    drawer.height = clampDrawerHeight(drag.top - event.clientY, drag.total);
    drawerEl.style.height = `${drawer.height}px`;
  });
  function endDrag() {
    if (!drag) return;
    drag = null;
    doc.body.classList.remove('resizing-drawer');
    persist({ drawerHeight: drawer.height });
    onDrawerChange(drawer.open);
  }
  doc.defaultView.addEventListener('mouseup', endDrag);

  // --- worktree and prefs ------------------------------------------------------
  function resetWorktreeState() {
    summary = null;
    selectedPath = null;
    fileView = null;
    selectedHunk = null;
    pendingReject = null;
    forceOpen.clear();
    for (const key of Object.keys(progress)) delete progress[key];
    filter = '';
    filterInput.value = '';
    nodeFilter = null;
    slice = null;
    selectedNode = null;
    expanded = [];
    showHidden = false;
    composer = { ...composer, context: null, error: '', pickedId: null };
    for (const key of Object.keys(serial)) serial[key]++;
  }

  // explicit: the drawer was just set by hand, before this worktree was picked.
  async function loadPrefs({ explicit = false } = {}) {
    const mine = ++prefsSerial;
    const setsBefore = drawerSets;
    const saved = worktree ? await api.reviewPrefs(worktree).catch(() => ({})) : {};
    if (mine !== prefsSerial) return;
    if (!pinnedTab && TAB_IDS.has(saved?.tab)) {
      tab = saved.tab;
      showTab();
    }
    if (Number.isFinite(saved?.drawerHeight)) drawer.height = saved.drawerHeight;
    // The Maestro following a músico leaves the drawer where it is, too.
    const keep = explicit || drawerSets !== setsBefore || pinnedTab;
    const wasOpen = drawer.open;
    if (!keep && typeof saved?.drawerOpen === 'boolean') drawer.open = saved.drawerOpen;
    else if (explicit && worktree && saved?.drawerOpen !== drawer.open) persist({ drawerOpen: drawer.open });
    applyDrawer({ notify: drawer.open !== wasOpen });
    const opened = saved?.openFiles?.[0];
    if (opened && !selectedPath) selectedPath = opened;
    refreshVisible();
  }

  // Called on every render of the workspace: cheap unless the worktree moved.
  function setContext(next) {
    sessions = next.sessions ?? [];
    agentId = next.agentId ?? null;
    const explicit = drawerSets !== drawerSetsSeen;
    drawerSetsSeen = drawerSets;
    if (next.worktree !== worktree) {
      worktree = next.worktree ?? null;
      resetWorktreeState();
      drawEmpty();
      loadPrefs({ explicit });
    }
    renderComposerPanel();
  }

  // --- Resumo and the file list ---------------------------------------------
  async function loadSummary() {
    const mine = ++serial.summary;
    const wt = worktree;
    const result = await api.reviewSummary(wt);
    if (mine !== serial.summary || wt !== worktree) return;
    summary = result;
    drawSummary();
    drawList();
  }

  function drawSummary() {
    if (!summary) {
      summaryHead.innerHTML = '<p class="review-note">não deu pra ler este worktree</p>';
      return;
    }
    const base = summary.baseError ? `<p class="review-note warn">${escapeHtml(summary.baseError)}</p>` : '';
    summaryHead.innerHTML = renderSummary({ verdict: summary.verdict, request: requestText(summary.request) }) + base;
    const ask = summaryHead.querySelector('.summary-request p');
    if (ask) ask.classList.add('request-text');
  }

  function drawList() {
    if (tab !== 'changes') return;
    const files = nodeFilter ? (summary?.files ?? []).filter((f) => nodeFilter.files.includes(f.path)) : summary?.files ?? [];
    const top = filesEl.scrollTop;
    filesEl.innerHTML = summary?.baseError ? `<div class="review-empty">${escapeHtml(summary.baseError)}</div>` : renderFileList(files, summary?.order, { selectedPath, approvedByFile: progress, filter });
    filesEl.scrollTop = top;
    nodeFilterEl.innerHTML = nodeFilter
      ? `<span class="node-filter">filtro: ${escapeHtml(nodeFilter.label)} <button data-review-action="clear-node-filter" title="Tirar o filtro">×</button></span>`
      : '';
    // The node filter opens its file at once: that is where the reader wants to go.
    if (nodeFilter && !selectedPath && files.length) openFile(files[0].path, { context: false });
    if (!selectedPath) diffEl.innerHTML = '<div class="review-empty">escolha um arquivo</div>';
  }

  // --- one file's diff -------------------------------------------------------
  async function loadFile() {
    const mine = ++serial.file;
    const wt = worktree;
    const path = selectedPath;
    const result = await api.reviewFile(wt, path, forceOpen.has(path));
    if (mine !== serial.file || wt !== worktree || path !== selectedPath) return;
    fileView = result;
    if (result?.hunks?.length) progress[path] = { approved: result.hunks.filter((h) => h.approved).length, total: result.hunks.length };
    drawFile();
    drawList();
  }

  function drawFile({ keepScroll = true } = {}) {
    const top = keepScroll ? diffEl.scrollTop : 0;
    if (!fileView) {
      diffEl.innerHTML = '<div class="review-empty">não deu pra ler este arquivo</div>';
      return;
    }
    if (fileView.error) {
      diffEl.innerHTML = `<div class="review-empty">${escapeHtml(fileView.error)}</div>`;
      return;
    }
    diffEl.innerHTML = renderFileDiff(fileView, { selectedHunk: selectedHunk?.id, forceOpen: forceOpen.has(fileView.path) });
    if (pendingReject) {
      diffEl.querySelector(`section.hunk[data-hunk-id="${CSS.escape(pendingReject)}"] .hunk-head`)?.insertAdjacentHTML(
        'afterend',
        '<div class="reject-confirm">desfazer este trecho? <button data-review-action="reject-yes">desfazer</button> <button data-review-action="reject-no">não</button></div>',
      );
    }
    diffEl.scrollTop = top;
    // From a node: the first hunk inside its lines, in view and selected.
    if (nodeFilter?.range && !selectedHunk && fileView.path === selectedPath) {
      const hunk = fileView.hunks?.find((h) => hunkInRange(h, nodeFilter.range));
      if (hunk) {
        selectHunk(hunk, { context: false });
        diffEl.querySelector(`section.hunk[data-hunk-id="${CSS.escape(hunk.id)}"]`)?.scrollIntoView({ block: 'start' });
      }
    }
  }

  function openFile(path, { context = true } = {}) {
    const changed = path !== selectedPath;
    selectedPath = path;
    if (changed) {
      fileView = null;
      selectedHunk = null;
      pendingReject = null;
      diffEl.scrollTop = 0;
    }
    if (context) setComposerContext({ kind: 'file', path });
    persist({ openFiles: [path] });
    loadFile();
  }

  function selectHunk(hunk, { context = true } = {}) {
    selectedHunk = { id: hunk.id, path: fileView.path, newStart: hunk.newStart, newLines: hunk.newLines };
    for (const el of diffEl.querySelectorAll('section.hunk.selected')) el.classList.remove('selected');
    diffEl.querySelector(`section.hunk[data-hunk-id="${CSS.escape(hunk.id)}"]`)?.classList.add('selected');
    // The node it belongs to lights up the next time Impacto draws.
    if (slice?.slice) selectedNode = nodeOfHunk(slice.slice, fileView.path, hunk) ?? selectedNode;
    if (context) setComposerContext(hunkContext(fileView.path, hunk));
  }

  const hunkById = (id) => fileView?.hunks?.find((h) => h.id === id) ?? null;

  async function hunkAction(action, id) {
    const hunk = hunkById(id);
    if (!hunk || !fileView) return;
    const path = fileView.path;
    if (action === 'approve') {
      await api.reviewApprove(worktree, id, !hunk.approved);
      loadFile();
      loadSummary();
    } else if (action === 'reject') {
      pendingReject = id;
      drawFile();
    } else if (action === 'comment') {
      selectHunk(hunk);
      composerEl.querySelector('[data-composer="draft"]')?.focus();
    } else if (action === 'explain') {
      const { sessionId } = composerTarget(sessions, composer.pickedId, agentId);
      if (!sessionId) return notify('nenhum chat neste worktree pra explicar');
      const result = await api.reviewCompose(sessionId, hunkContext(path, hunk), EXPLAIN_TEXT);
      notify(result?.ok ? 'pedi pro agente explicar o trecho' : result?.error ?? 'não deu pra pedir');
    }
  }

  async function confirmReject() {
    const id = pendingReject;
    pendingReject = null;
    const path = fileView?.path;
    if (!id || !path) return;
    const { sessionId } = composerTarget(sessions, composer.pickedId, agentId);
    const result = await api.reviewReject(worktree, path, id, sessionId);
    if (!result?.ok) notify(result?.error ?? 'não deu pra desfazer');
    else notify('trecho desfeito; o agente foi avisado');
    loadFile();
    loadSummary();
  }

  // --- Impacto ---------------------------------------------------------------
  async function loadSlice() {
    const mine = ++serial.slice;
    const wt = worktree;
    const result = await api.reviewSlice(wt, expanded, showHidden);
    if (mine !== serial.slice || wt !== worktree) return;
    slice = result;
    if (selectedHunk && slice?.slice) selectedNode = nodeOfHunk(slice.slice, selectedHunk.path, selectedHunk) ?? selectedNode;
    drawSlice();
  }

  const sliceNode = (id) => slice?.slice?.nodes?.find((n) => n.id === id) ?? null;
  const sliceMore = (id) => slice?.slice?.more?.find((m) => m.id === id) ?? null;

  function drawSlice() {
    const node = sliceNode(selectedNode);
    const actions = node
      ? `<span class="impact-picked">${escapeHtml(node.label)}</span><button data-review-action="node-changes">ver em Mudanças</button>${
        node.kind === 'module' ? `<button data-review-action="node-expand">${expanded.includes(node.id) ? 'fechar funções' : 'abrir funções'}</button>` : ''
      }<button data-review-action="node-hop2">${expanded.includes(`hop2:${node.id}`) ? 'menos' : '2º salto'}</button>`
      : '<span class="impact-hint">clique num nó pra ver as mudanças dele</span>';
    impactTools.innerHTML = `<label class="impact-hidden"><input type="checkbox" data-review-action="show-hidden"${showHidden ? ' checked' : ''}> mostrar escondidos</label>${actions}`;
    if (slice?.status !== 'ready') {
      impactEl.innerHTML = renderSliceStatus(slice) || '<p class="slice-status">…</p>';
      return;
    }
    const data = slice.slice;
    if (!data?.nodes?.length && !data?.more?.length) {
      impactEl.innerHTML = '<p class="slice-status">nenhuma função alterada que o grafo conheça</p>';
      return;
    }
    const layout = layoutSlice(data, { width: impactEl.clientWidth || 0 });
    const more = sliceMore(selectedNode);
    const list = more ? `<ul class="slice-more-list">${more.ids.map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul>` : '';
    impactEl.innerHTML = renderSlice(data, layout, { selectedId: selectedNode }) + list;
  }

  function toggleExpanded(id) {
    expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
    loadSlice();
  }

  // --- the composer ----------------------------------------------------------
  function setComposerContext(context) {
    composer.context = context;
    composer.error = '';
    renderComposerPanel();
  }

  function renderComposerPanel() {
    const target = composerTarget(sessions, composer.pickedId, agentId);
    const signature = JSON.stringify([target.sessionId, sessions, composer.context, composer.error]);
    if (signature === composerSignature) return;
    composerSignature = signature;
    const before = composerEl.querySelector('[data-composer="draft"]');
    const focused = before && doc.activeElement === before;
    const caret = focused ? before.selectionStart : null;
    composerEl.innerHTML = renderComposer({ target, context: composer.context, draft: composer.draft, error: composer.error });
    if (focused) {
      const after = composerEl.querySelector('[data-composer="draft"]');
      after.focus();
      after.setSelectionRange(caret, caret);
    }
  }

  async function sendComposer() {
    if (composer.sending) return;
    const { sessionId } = composerTarget(sessions, composer.pickedId, agentId);
    if (!sessionId) {
      composer.error = 'nenhum chat neste worktree';
      renderComposerPanel();
      return;
    }
    composer.sending = true;
    const result = await api.reviewCompose(sessionId, composer.context, composer.draft);
    composer.sending = false;
    if (!result?.ok) {
      composer.error = result?.error ?? 'não deu pra mandar';
      renderComposerPanel();
      return;
    }
    composer.draft = '';
    composer.error = '';
    composerSignature = null;
    renderComposerPanel();
    notify('mandei pro agente');
  }

  composerEl.addEventListener('input', (event) => {
    if (event.target.matches('[data-composer="draft"]')) composer.draft = event.target.value;
  });
  composerEl.addEventListener('change', (event) => {
    if (!event.target.matches('[data-composer="target"]')) return;
    composer.pickedId = event.target.value;
    renderComposerPanel();
  });
  composerEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey && event.target.matches('[data-composer="draft"]')) {
      event.preventDefault();
      sendComposer();
    }
  });
  composerEl.addEventListener('click', (event) => {
    if (event.target.closest('[data-composer="send"]')) sendComposer();
    else if (event.target.closest('[data-composer="clear"]')) setComposerContext(null);
  });

  // --- clicks inside the review ----------------------------------------------
  tabsEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-review-tab]');
    if (button) setTab(button.dataset.reviewTab);
  });

  summaryHead.addEventListener('click', (event) => {
    const item = event.target.closest('[data-verdict]');
    if (!item || !worktree) return;
    const action = verdictAction(item.dataset.verdict);
    if (action.tab) setTab(action.tab);
    else api.reviewVerify(worktree, action.verify).catch(() => {});
  });

  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    drawList();
  });

  panels.changes.addEventListener('click', (event) => {
    const target = event.target;
    const hunkButton = target.closest('[data-hunk-action]');
    if (hunkButton) {
      if (!hunkButton.disabled) hunkAction(hunkButton.dataset.hunkAction, hunkButton.dataset.hunkId);
      return;
    }
    const action = target.closest('[data-review-action]')?.dataset.reviewAction;
    if (action === 'reject-yes') return void confirmReject();
    if (action === 'reject-no') {
      pendingReject = null;
      return void drawFile();
    }
    if (action === 'clear-node-filter') {
      nodeFilter = null;
      return void drawList();
    }
    if (target.closest('[data-file-action="force-open"]') && fileView) {
      forceOpen.add(fileView.path);
      return void loadFile();
    }
    const row = target.closest('.review-file[data-path]');
    if (row) return void openFile(row.dataset.path);
    const section = target.closest('section.hunk[data-hunk-id]');
    if (section) {
      const hunk = hunkById(section.dataset.hunkId);
      if (hunk) selectHunk(hunk);
    }
  });

  panels.impact.addEventListener('click', (event) => {
    const action = event.target.closest('[data-review-action]')?.dataset.reviewAction;
    const node = sliceNode(selectedNode);
    if (action === 'show-hidden') {
      showHidden = event.target.checked;
      return void loadSlice();
    }
    if (action === 'node-changes') return void setTab('changes');
    if (action === 'node-expand' && node) return void toggleExpanded(node.id);
    if (action === 'node-hop2' && node) return void toggleExpanded(`hop2:${node.id}`);
    const hit = event.target.closest('[data-node]');
    if (!hit) return;
    selectedNode = hit.dataset.node;
    const picked = sliceNode(selectedNode);
    if (picked?.files?.length) {
      // Mudanças now shows only this node's files, from its first hunk in range.
      nodeFilter = { label: String(picked.label ?? picked.id), files: picked.files, range: picked.range ?? null };
      if (!picked.files.includes(selectedPath)) {
        selectedPath = null;
        fileView = null;
      }
      selectedHunk = null;
      setComposerContext(nodeContext(picked));
    }
    drawSlice();
  });

  api.onReviewChanged(({ worktree: changed } = {}) => {
    if (changed === worktree) refreshVisible();
  });

  showTab();
  applyDrawer();
  drawEmpty();

  return {
    setContext,
    setTab,
    tab: () => tab,
    setDrawer,
    toggleDrawer: () => setDrawer(!drawer.open),
    drawerOpen: () => drawer.open,
    // The Maestro keeps the view it found and puts it back on leaving (#159).
    saveView: () => ({ tab, drawerOpen: drawer.open }),
    restoreView(saved) {
      pinnedTab = false;
      if (!saved) return;
      setTab(saved.tab, { persist: false });
      setDrawer(saved.drawerOpen, { persist: false });
    },
  };
}
