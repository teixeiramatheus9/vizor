import { describe, it, expect } from 'vitest';
import {
  ICONS,
  escapeHtml,
  renderEmpty,
  renderSidebar,
  editStatusIcon,
  renderCards,
  renderFileView,
  renderInspectorHeader,
  renderRail,
  renderTaskPicker,
  renderTimeline,
  renderTabs,
  renderTerminalPlaceholder,
  renderTopBar,
  statusIcon,
} from '../src/renderer/workspace-view.js';

const session = (id, extra = {}) => ({
  id, name: id, status: 'working', unread: false, needsPermission: false, inside: false, files: [], ...extra,
});
const tree = (sessions, worktree = {}) => ({
  projects: [
    { root: '/r', name: 'r', worktrees: [{ path: '/r', branch: 'main', prunable: false, sessions, ...worktree }] },
  ],
  unplaced: [],
  counts: { working: 2, waiting: 1 },
});

describe('escapeHtml', () => {
  it('escapes markup, ampersands and quotes', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('statusIcon', () => {
  it('permission beats waiting, waiting beats the rest', () => {
    expect(statusIcon(session('s', { status: 'waiting', needsPermission: true }))).toBe(ICONS.permission);
    expect(statusIcon(session('s', { status: 'waiting' }))).toBe(ICONS.waiting);
    expect(statusIcon(session('s', { status: 'done' }))).toBe(ICONS.done);
    expect(statusIcon(session('s'))).toBe(ICONS.working);
  });
});

describe('renderSidebar', () => {
  it('escapes every name and path it shows', () => {
    const html = renderSidebar(tree([session('<img onerror=1>')], { branch: 'a&b' }), null);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img onerror=1&gt;');
    expect(html).toContain('a&amp;b');
  });

  it('marks the selected session', () => {
    const html = renderSidebar(tree([session('s1'), session('s2')]), 's2');
    expect(html).toContain('data-session="s2" aria-selected="true"');
    expect(html).toContain('data-session="s1" aria-selected="false"');
  });

  it('shows file counts, unknown counts as ±?', () => {
    const files = [
      { filePath: '/r/src/a.js', added: 6, removed: 1, writing: false },
      { filePath: '/r/b.js', added: null, removed: null, writing: true },
    ];
    const html = renderSidebar(tree([session('s1', { files })]), 's1');
    expect(html).toContain('a.js');
    expect(html).toContain('+6 −1');
    expect(html).toContain('±?');
  });

  it('labels detached and removed worktrees', () => {
    expect(renderSidebar(tree([], { branch: null }), null)).toContain('(sem branch)');
    expect(renderSidebar(tree([], { prunable: true }), null)).toContain('(removida)');
  });

  it('tells sessions in the Vizor from the ones in another terminal', () => {
    const html = renderSidebar(tree([session('in', { inside: true }), session('out')]), null);
    expect(html).toContain('title="no Vizor"');
    expect(html).toContain('title="em outro terminal"');
  });

  it('offers to drop a project from the list', () => {
    expect(renderSidebar(tree([]), null)).toContain('data-remove-project="/r" title="Tirar da lista"');
  });

  it('renders the empty state with no projects', () => {
    expect(renderSidebar({ projects: [], unplaced: [], counts: { working: 0, waiting: 0 } }, null)).toBe(
      renderEmpty(),
    );
    expect(renderEmpty()).toContain('Nenhum projeto ainda');
    expect(renderEmpty()).toContain('Abrir projeto…');
  });
});

describe('sessions outside every project', () => {
  it('get their own section at the end of the sidebar', () => {
    const base = tree([]);
    const html = renderSidebar({ ...base, unplacedSessions: [session('<solta>')] }, null);
    expect(html).toContain('Fora de projetos');
    expect(html).toContain('&lt;solta&gt;');
    expect(html.indexOf('Fora de projetos')).toBeGreaterThan(html.indexOf('data-remove-project'));
  });

  it('still show with no project at all, after the empty state', () => {
    const html = renderSidebar(
      { projects: [], unplaced: ['/tmp'], unplacedSessions: [session('s1')], counts: { working: 1, waiting: 0 } },
      null,
    );
    expect(html).toContain('Nenhum projeto ainda');
    expect(html).toContain('data-session="s1"');
  });
});

describe('renderTopBar', () => {
  it('shows how many sessions run and wait', () => {
    const html = renderTopBar(tree([]));
    expect(html).toContain('2 rodando');
    expect(html).toContain('1 esperando');
  });
});

describe('renderTabs', () => {
  const term = (id, extra = {}) => ({ id, cwd: '/r', alive: true, exitCode: null, ...extra });

  it('escapes titles and marks the active tab', () => {
    const html = renderTabs([term('p1'), term('p2')], 'p2', { p1: '<b>x</b>' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('data-tab="p2" aria-selected="true"');
    expect(html).toContain('data-tab="p1" aria-selected="false"');
  });

  it('numbers untitled tabs and labels the ones that ended', () => {
    const html = renderTabs([term('p1'), term('p2', { alive: false, exitCode: 1 })], 'p1', {});
    expect(html).toContain('terminal 2');
    expect(html).toContain('encerrado (1)');
    expect(html).toContain('data-close-tab="p2" title="Fechar"');
  });

  it('always offers a new terminal', () => {
    expect(renderTabs([], null, {})).toContain('data-new-terminal title="Novo terminal com claude"');
  });
});

describe('renderTerminalPlaceholder', () => {
  it('explains each empty state', () => {
    expect(renderTerminalPlaceholder('none')).toContain('Escolha uma worktree e abra um terminal com +.');
    const outside = renderTerminalPlaceholder('outside');
    expect(outside).toContain('Essa sessão roda em outro terminal.');
    expect(outside).toContain('data-focus-outside');
    expect(outside).toContain('Ir pro terminal');
    expect(renderTerminalPlaceholder('unavailable:sem <pty>')).toContain('Terminal indisponível: sem &lt;pty&gt;');
  });
});

describe('worktree header', () => {
  it('is selectable by its path', () => {
    expect(renderSidebar(tree([], { path: '/r&x' }), null)).toContain('data-worktree="/r&amp;x"');
  });

describe('selected worktree (#119)', () => {
  it('is marked in the sidebar', () => {
    const html = renderSidebar(tree([]), null, '/r');
    expect(html).toContain('data-worktree="/r" aria-current="true"');
  });
});
});

describe('inspector', () => {
  const at = new Date(2026, 9, 24, 14, 2).getTime();
  const ev = (id, seq, extra = {}) => ({
    id, seq, filePath: `/r/${id}.js`, relPath: `${id}.js`, toolName: 'Edit', status: 'applied',
    startedAt: at, endedAt: at, reason: `porque ${seq}`, note: null, added: 2, removed: 1, baseline: 'reverse',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-velho', '+<script>&', '+novo'] }],
    ...extra,
  });
  const task = (edits) => ({ id: 's:1', prompt: 'p', startedAt: at, endedAt: null, edits });

  it('timeline marks the selection, shows counts, time and the reason', () => {
    const html = renderTimeline(task([ev('a', 1), ev('b', 2, { reason: '<b>x</b>' })]), 'b', { following: true, newCount: 0 });
    expect(html).toContain('data-edit="b" aria-selected="true"');
    expect(html).toContain('#1');
    expect(html).toContain('+2 −1');
    expect(html).toContain('14:02');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('data-follow');
  });

  it('offers to follow the AI only when it stopped following', () => {
    expect(renderTimeline(task([ev('a', 1)]), 'a', { following: false, newCount: 3 })).toContain(
      '<button data-follow>seguir a IA (3)</button>',
    );
    expect(renderTimeline(task([ev('a', 1)]), 'a', { following: false, newCount: 0 })).not.toContain('data-follow');
  });

  it('says when the task has no change yet', () => {
    expect(renderTimeline(task([]), null, { following: true, newCount: 0 })).toContain(
      'Nenhuma mudança nesta tarefa ainda.',
    );
    expect(renderTimeline(null, null, { following: true, newCount: 0 })).toContain('Nenhuma mudança nesta tarefa ainda.');
  });

  it('labels edits that never landed or are still being written', () => {
    expect(renderTimeline(task([ev('a', 1, { status: 'not-applied' })]), null, { following: true, newCount: 0 })).toContain(
      'não aplicada',
    );
    expect(editStatusIcon({ status: 'not-applied' })).toBe(ICONS.skipped);
    expect(editStatusIcon({ status: 'writing' })).toBe(ICONS.writing);
    expect(editStatusIcon({ status: 'applied' })).toBe(ICONS.done);
  });

  it('cards show each edit with only its hunk, escaped', () => {
    const html = renderCards(task([ev('a', 1), ev('b', 2)]), 'b');
    expect(html.match(/<article class="card/g)).toHaveLength(2);
    expect(html).toContain('data-card="b" aria-current="true"');
    expect(html).toContain('&lt;script&gt;&amp;');
    expect(html).not.toContain('<script>');
  });

  it('notes replace the diff with plain pt-BR copy', () => {
    const copy = {
      'no-diff': 'não deu pra montar o diff',
      'too-large': 'arquivo grande demais pra mostrar o diff',
      binary: 'arquivo binário',
      unreadable: 'não deu pra ler o arquivo',
    };
    for (const [note, text] of Object.entries(copy)) {
      expect(renderCards(task([ev('a', 1, { note, hunks: [] })]), null)).toContain(text);
      expect(renderFileView({ relPath: 'a.js', rows: [], anchors: {}, unplaced: [], note }, {}, null)).toContain(text);
    }
    expect(renderTimeline(task([ev('a', 1, { note: 'no-diff', added: 0, removed: 0 })]), null, { following: true, newCount: 0 })).toContain('±?');
  });

  it('file view puts banners above their rows and escapes the code', () => {
    const rows = [
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'add', oldNo: null, newNo: 2, text: '<script>&' },
    ];
    const html = renderFileView({ relPath: 'a.js', rows, anchors: { 1: ['b'] }, unplaced: ['a'] }, { a: ev('a', 1), b: ev('b', 2) }, 'b');
    expect(html).toContain('edições sem posição neste arquivo');
    expect(html).toContain('data-banner="b" aria-current="true"');
    expect(html.indexOf('data-banner="b"')).toBeLessThan(html.indexOf('&lt;script&gt;&amp;'));
    expect(html).not.toContain('<script>');
  });

  it('header toggles the mode and the width', () => {
    const html = renderInspectorHeader({ mode: 'cards', width: 'compact', editCount: 4, writing: false });
    expect(html).toContain('data-mode="arquivo" aria-pressed="false"');
    expect(html).toContain('data-mode="cards" aria-pressed="true"');
    expect(html).toContain('title="Mais largo"');
    expect(html).toContain('data-collapse title="Recolher"');
    expect(renderInspectorHeader({ mode: 'arquivo', width: 'wide', editCount: 0, writing: false })).toContain('title="Mais estreito"');
  });

  it('collapsed rail shows the count and pulses while writing', () => {
    const html = renderRail({ editCount: 7, writing: true });
    expect(html).toContain('data-expand');
    expect(html).toContain('title="Mostrar mudanças"');
    expect(html).toContain('>7<');
    expect(html).toContain('writing');
  });

  it('task picker starts with the current task', () => {
    const html = renderTaskPicker([{ id: 't2', prompt: '<x>', startedAt: at, edits: 2 }], null);
    expect(html).toContain('data-task-picker');
    expect(html).toContain('<option value="">tarefa atual</option>');
    expect(html).toContain('&lt;x&gt;');
  });
});
