import { describe, it, expect } from 'vitest';
import {
  ICONS,
  escapeHtml,
  renderEmpty,
  renderSidebar,
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
});
