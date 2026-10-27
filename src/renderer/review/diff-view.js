// The review screen's HTML builders: the file list and one file's diff. Pure
// strings, like plan-view; every path, line and message goes through escapeHtml.
import { escapeHtml } from '../workspace-view.js';
import { skeleton } from '../shared/skeleton.js';
import { highlightLine, initialState } from './highlight.js';

const MAX_VIEW_LINES = 3000;
const STATUS_MARK = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
const UNTRACKED_REASON = 'arquivo novo: peça pro agente apagar';
const COMMITTED_REASON = 'já está num commit; comente pra o agente reverter';

const HUNK_BUTTONS = [['approve', 'Aprovar'], ['reject', 'Rejeitar'], ['comment', 'Comentar'], ['explain', 'Explicar']];

function hunkActions(hunk, untracked) {
  return HUNK_BUTTONS.map(([action, label]) => {
    let extra = '';
    if (action === 'reject' && (hunk.committed || untracked)) extra = ` disabled title="${escapeHtml(untracked ? UNTRACKED_REASON : COMMITTED_REASON)}"`;
    if (action === 'approve' && hunk.approved) extra = ' aria-pressed="true"';
    return `<button class="hunk-btn" data-hunk-action="${action}" data-hunk-id="${escapeHtml(hunk.id)}"${extra}>${label}</button>`;
  }).join('');
}

function renderHunk(hunk, { highlight, untracked, selected, errorsByLine, readOnly }) {
  // Removed lines belong to the old file and added ones to the new, so each
  // side keeps its own state; context lines advance both.
  let oldState = initialState();
  let newState = initialState();
  const rows = hunk.lines.map((line) => {
    const cls = line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx';
    let body;
    if (highlight) {
      const out = highlightLine(line.text, line.kind === '-' ? oldState : newState);
      body = out.html;
      if (line.kind === ' ') {
        oldState = highlightLine(line.text, oldState).state;
        newState = out.state;
      } else if (line.kind === '-') oldState = out.state;
      else newState = out.state;
    } else body = escapeHtml(line.text);
    // The gutter is generated content (CSS ::before on data-gutter), not three
    // spans: a long diff costs the renderer three fewer DOM nodes per line.
    const gutter = `${String(line.oldNo ?? '').padStart(5)}${String(line.newNo ?? '').padStart(5)} ${line.kind}`;
    let html = `<div class="diff-line ${cls}" data-gutter="${escapeHtml(gutter)}"><code>${body}</code></div>`;
    if (line.noNewline) html += '<div class="diff-line nonl"><code>\\ sem quebra de linha no fim</code></div>';
    // tsc reports against the new file, so only lines that exist there.
    if (line.kind !== '-' && line.newNo != null) {
      for (const err of errorsByLine.get(line.newNo) ?? []) {
        html += `<div class="tsc-error">tsc ${escapeHtml(err.line)}:${escapeHtml(err.col)} · ${escapeHtml(err.message)}</div>`;
      }
    }
    return html;
  });
  return `<section class="hunk${selected ? ' selected' : ''}${hunk.approved ? ' approved' : ''}" data-hunk-id="${escapeHtml(hunk.id)}">`
    + `<header class="hunk-head"><span class="hunk-header">${escapeHtml(hunk.header)}</span><span class="hunk-actions">${readOnly ? '' : hunkActions(hunk, untracked)}</span></header>`
    + `${rows.join('')}</section>`;
}

// readOnly: a step's diff, a view of what was; nothing to approve or reject.
export function renderFileDiff(file, { highlight, selectedHunk, forceOpen, readOnly = false } = {}) {
  const path = file.path ?? '';
  const useHighlight = highlight ?? /\.(m|c)?[jt]sx?$/.test(path);
  const head = `<div class="diff-file-head" title="${escapeHtml(path)}">${escapeHtml(path)}</div>`;
  if (file.binary) return `${head}<div class="diff-note">binário</div>`;
  const total = file.lines ?? file.hunks?.reduce((n, h) => n + h.lines.length, 0) ?? 0;
  if (!forceOpen && total > MAX_VIEW_LINES) {
    return `${head}<div class="diff-note">${total} linhas de diff <button class="hunk-btn" data-file-action="force-open">abrir mesmo assim</button></div>`;
  }
  if (file.tooBig) return `${head}<div class="diff-note">grande demais pra mostrar</div>`;
  const errorsByLine = new Map();
  for (const err of file.tscErrors ?? []) {
    if (!errorsByLine.has(err.line)) errorsByLine.set(err.line, []);
    errorsByLine.get(err.line).push(err);
  }
  const hunks = (file.hunks ?? []).map((hunk) => renderHunk(hunk, {
    highlight: useHighlight, untracked: !!file.untracked, selected: hunk.id === selectedHunk, errorsByLine, readOnly,
  }));
  return `${head}${hunks.join('') || '<div class="diff-note">sem mudanças</div>'}`;
}

// The bar on top of a step's file list: which step, and the way back to the whole diff.
export function renderStepBar(n) {
  const step = escapeHtml(n);
  return '<div class="step-bar">'
    + `<button class="hunk-btn" data-review-action="step-prev" title="Passo anterior"${n <= 1 ? ' disabled' : ''}>‹</button>`
    + `<span class="step-label">passo ${step}</span>`
    + '<button class="hunk-btn" data-review-action="step-next" title="Próximo passo">›</button>'
    + '<button class="hunk-btn" data-review-action="whole-diff">ver o diff inteiro</button></div>';
}

export const STEP_TOGETHER_NOTE = 'passos marcados juntos: este passo foi marcado junto com outro, então as mudanças aparecem no último deles';

// files: summary files; order: paths in reading order; approvedByFile:
// { [path]: { approved, total } }; filter: case-insensitive path substring.
export function renderFileList(files, order, { selectedPath, approvedByFile = {}, filter = '', loading = false } = {}) {
  if (loading) return skeleton('list', 6);
  const byPath = new Map((files ?? []).map((f) => [f.path, f]));
  const needle = filter.trim().toLowerCase();
  const sorted = (order?.length ? order : [...byPath.keys()]).map((p) => byPath.get(p)).filter(Boolean)
    .filter((f) => !needle || f.path.toLowerCase().includes(needle));
  if (!sorted.length) {
    // An empty worktree says what to do next; a filter that hides everything says so.
    return needle ? '<div class="review-empty empty-state">nenhum arquivo bate com o filtro</div>'
      : '<div class="review-empty empty-state">nenhuma mudança ainda: puxe uma issue no Ctrl+K</div>';
  }
  // Neighbours in the same folder share a heading; the reading order itself
  // (contract files first) must not be reshuffled by folder.
  const groups = [];
  for (const file of sorted) {
    const slash = file.path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : file.path.slice(0, slash);
    if (groups.at(-1)?.[0] === dir) groups.at(-1)[1].push(file);
    else groups.push([dir, [file]]);
  }
  return groups.map(([dir, list]) => {
    const rows = list.map((f) => {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      const sums = f.binary ? '<span class="sum">binário</span>'
        : `<span class="sum"><span class="plus">+${escapeHtml(f.added ?? '?')}</span> <span class="minus">−${escapeHtml(f.removed ?? '?')}</span></span>`;
      const progress = approvedByFile[f.path];
      const prog = progress?.total ? `<span class="approved-count">${escapeHtml(progress.approved)}/${escapeHtml(progress.total)}</span>` : '';
      const contract = f.contract ? '<span class="contract-badge" title="mudou o contrato">contrato</span>' : '';
      return `<li class="review-file${f.path === selectedPath ? ' selected' : ''}" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">`
        + `<span class="status ${escapeHtml(f.status)}">${STATUS_MARK[f.status] ?? 'M'}</span><span class="name">${escapeHtml(name)}</span>${contract}${sums}${prog}</li>`;
    });
    return `<div class="review-group"><div class="review-dir">${escapeHtml(dir)}</div><ul>${rows.join('')}</ul></div>`;
  }).join('');
}
