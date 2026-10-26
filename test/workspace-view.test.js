import { describe, it, expect } from 'vitest';
import {
  ICONS,
  escapeHtml,
  renderEmpty,
  renderSidebar,
  editStatusIcon,
  renderCards,
  renderComments,
  renderComposer,
  renderFileView,
  renderInspectorHeader,
  renderNewTerminalMenu,
  timeAgo,
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

  it('toggles the chat away so the code takes the screen (#161)', () => {
    expect(renderTopBar(tree([]), { chatHidden: false })).toContain('data-toggle-chat');
    expect(renderTopBar(tree([]), { chatHidden: false })).toContain('Esconder chat');
    expect(renderTopBar(tree([]), { chatHidden: true })).toContain('Mostrar chat');
  });

  it('says who the voice is talking to, escaped', () => {
    const html = renderTopBar(tree([]), { voice: { state: 'listening', target: 'chat da <22>' } });
    expect(html).toContain('ouvindo');
    expect(html).toContain('chat da &lt;22&gt;');
    expect(renderTopBar(tree([]), { voice: null })).not.toContain('voice-state');
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
    expect(renderTabs([], null, {})).toContain('data-new-terminal title="Novo terminal"');
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
    expect(html).toContain('Alargar');
    expect(html).toContain('title="Alargar o painel de mudanças"');
    expect(html).toContain('Ocultar');
    expect(html).toContain('title="Ocultar o painel de mudanças (Ctrl+Shift+E)"');
    const wide = renderInspectorHeader({ mode: 'arquivo', width: 'wide', editCount: 0, writing: false });
    expect(wide).toContain('Estreitar');
    expect(wide).toContain('title="Estreitar o painel de mudanças"');
  });

  it('collapsed rail shows the count and pulses while writing', () => {
    const html = renderRail({ editCount: 7, writing: true });
    expect(html).toContain('data-expand');
    expect(html).toContain('title="Mostrar o painel de mudanças (Ctrl+Shift+E)"');
    expect(html).toContain('<svg');
    expect(html).toContain('>7<');
    expect(html).toContain('writing');
  });

  it('task picker starts with the current task and lists only the earlier ones', () => {
    const html = renderTaskPicker(
      [
        { id: 't3', prompt: 'atual', startedAt: at, edits: 1 },
        { id: 't2', prompt: '<x>', startedAt: at, edits: 2 },
      ],
      null,
    );
    expect(html).not.toContain('value="t3"');
    expect(html).toContain('data-task-picker');
    expect(html).toContain('<option value="">tarefa atual</option>');
    expect(html).toContain('&lt;x&gt;');
  });

  it('an edit still being written shows no counts and says so in the file view', () => {
    const writing = ev('w', 5, { status: 'writing', added: 0, removed: 0, hunks: [] });
    expect(renderTimeline(task([writing]), 'w', { following: true, newCount: 0 })).not.toContain('+0 −0');
    expect(renderFileView({ relPath: 'c.js', rows: [], anchors: {}, unplaced: [], note: 'writing' }, {}, 'w')).toContain(
      'a IA está escrevendo neste arquivo…',
    );
  });

  it('file view with a seal shows the whole file plus the warning (#93 review)', () => {
    const html = renderFileView({ relPath: 'a.js', rows: [{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'x' }], anchors: {}, unplaced: [], note: null, seal: 'no-diff' }, {}, null);
    expect(html).toContain('não deu pra montar o diff');
    expect(html).toContain('<span class="text">x</span>');
    expect(html).not.toContain('class="unplaced"');
  });
});

describe('command changes in the inspector (#94)', () => {
  const at = new Date(2026, 9, 24, 14, 2).getTime();
  const cmd = (extra = {}) => ({ id: 'c', seq: 3, filePath: '/r/b.txt', relPath: 'b.txt', toolName: 'Bash', status: 'by-command',
    startedAt: at, endedAt: at, reason: '$ sed', note: null, added: 1, removed: 1, baseline: 'git',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }], ...extra });
  const task = (edits) => ({ id: 's:1', prompt: '', startedAt: at, endedAt: null, edits });

  it('labels command changes and an uncertain owner', () => {
    const html = renderTimeline(task([cmd()]), null, { following: true, newCount: 0 });
    expect(html).toContain('por comando');
    expect(html).toContain(ICONS.command);
    expect(html).not.toContain('dono incerto');
    expect(renderTimeline(task([cmd({ uncertainOwner: true })]), null, { following: true, newCount: 0 })).toContain('dono incerto');
    expect(renderCards(task([cmd({ uncertainOwner: true })]), null)).toContain('dono incerto');
  });

  it('says a file was deleted, or that old contents were dropped', () => {
    expect(renderCards(task([cmd({ note: 'deleted', hunks: [] })]), null)).toContain('arquivo apagado');
    expect(renderFileView({ relPath: 'b.txt', rows: [], anchors: {}, unplaced: [], note: 'dropped' }, {}, null)).toContain(
      'conteúdo antigo descartado pra economizar memória',
    );
  });
});

describe('comments (#95)', () => {
  const at = new Date(2026, 9, 24, 14, 2).getTime();
  const ev = (id, seq, extra = {}) => ({ id, seq, filePath: `/r/${id}.js`, relPath: `${id}.js`, toolName: 'Edit', status: 'applied',
    startedAt: at, endedAt: at, reason: 'porque', note: null, added: 1, removed: 0, baseline: 'reverse',
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+x'] }], ...extra });
  const task = (edits) => ({ id: 's:1', prompt: '', startedAt: at, endedAt: null, edits });
  const comment = (status, text = 'oi') => ({ id: `c-${status}`, editId: 'a', text, status });

  it('every card and banner offers to comment', () => {
    expect(renderCards(task([ev('a', 1)]), null)).toContain('data-comment="a" title="Comentar esta mudança"');
    const file = { relPath: 'a.js', rows: [{ kind: 'add', oldNo: null, newNo: 1, text: 'x' }], anchors: { 0: ['a'] }, unplaced: [] };
    expect(renderFileView(file, { a: ev('a', 1) }, null)).toContain('data-comment="a" title="Comentar esta mudança"');
  });

  it('shows each comment under its edit with its state, escaped', () => {
    const byEdit = { a: [comment('queued', '<img onerror=1>'), comment('sending'), comment('sent'), comment('failed')] };
    const html = renderCards(task([ev('a', 1), ev('b', 2)]), null, byEdit);
    expect(html).toContain('na fila — sai quando a sessão liberar');
    expect(html).toContain('enviando…');
    expect(html).toContain('enviado');
    expect(html).toContain('não deu pra entregar');
    expect(html).toContain('data-copy-comment="c-failed" title="Copiar o comentário"');
    expect(html).not.toContain('data-copy-comment="c-sent"');
    expect(html).toContain('&lt;img onerror=1&gt;');
    expect(html).not.toContain('<img onerror');
    expect(html.indexOf('data-card="b"')).toBeGreaterThan(html.lastIndexOf('comment status-'));
    const file = { relPath: 'a.js', rows: [{ kind: 'add', oldNo: null, newNo: 1, text: 'x' }], anchors: { 0: ['a'] }, unplaced: [] };
    expect(renderFileView(file, { a: ev('a', 1) }, null, byEdit)).toContain('enviando…');
    expect(renderComments([])).toBe('');
  });

  it('the composer names the change and keeps the draft', () => {
    const html = renderComposer({ edit: ev('b', 2), draft: '<b>rascunho</b>', error: 'Escreve alguma coisa' });
    expect(html).toContain('Comentando #2 · b.js');
    expect(html).toContain('&lt;b&gt;rascunho&lt;/b&gt;</textarea>');
    expect(html).toContain('Escreve alguma coisa');
    expect(html).toContain('data-comment-send');
    expect(html).toContain('data-comment-cancel');
  });

  it('a comment left on the clipboard says so (#95 review)', () => {
    expect(renderComments([{ id: 'c1', editId: 'a', text: 'x', status: 'copied' }])).toContain('copiado — cola no terminal da sessão');
  });
});

describe('backlog fixes (#125, #139)', () => {
  it('copy for an edit that never landed', () => {
    expect(renderFileView({ relPath: 'a.js', rows: [], anchors: {}, unplaced: [], note: 'not-applied' }, {}, null)).toContain(
      'essa mudança não chegou a ser aplicada',
    );
  });

  it('unplaced edits can be commented in file mode', () => {
    const ev = { id: 'u1', seq: 4, relPath: 'a.js', reason: 'r', status: 'applied' };
    const html = renderFileView({ relPath: 'a.js', rows: [], anchors: {}, unplaced: ['u1'], note: null }, { u1: ev }, null);
    expect(html).toContain('data-comment="u1"');
  });
});

describe('collapsible sidebar (#152)', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => ({ filePath: `/r/f${i}.js`, added: 1, removed: 0, writing: false }));
  const twoSessions = () =>
    tree([session('a', { files: files(5) }), session('b', { status: 'waiting', files: files(2) })]);

  it('projects and worktrees are open by default, each with a fold toggle', () => {
    const html = renderSidebar(twoSessions(), null, null, {});
    expect(html).toContain('data-fold="p:/r" aria-expanded="true"');
    expect(html).toContain('data-fold="w:/r" aria-expanded="true"');
    expect(html).toContain('data-session="a"');
  });

  it('a folded project hides its worktrees and sums up what is inside', () => {
    const html = renderSidebar(twoSessions(), null, null, { 'p:/r': false });
    expect(html).toContain('data-fold="p:/r" aria-expanded="false"');
    expect(html).not.toContain('data-worktree=');
    expect(html).toContain('2 sessões · 7 arquivos');
    expect(html).toContain('class="fold-alert"');
  });

  it('a folded worktree hides its sessions and sums them up', () => {
    const html = renderSidebar(twoSessions(), null, null, { 'w:/r': false });
    expect(html).toContain('data-worktree="/r"');
    expect(html).not.toContain('data-session=');
    expect(html).toContain('2 sessões · 7 arquivos');
  });

  it('a session lists up to 3 files open; more start folded behind a count', () => {
    const html = renderSidebar(twoSessions(), null, null, {});
    expect(html).toContain('data-fold="s:a" aria-expanded="false"');
    expect(html).toContain('5 arquivos');
    expect(html).not.toContain('f4.js');
    expect(html).toContain('data-fold="s:b" aria-expanded="true"');
    expect(html).toContain('f1.js');
  });

  it('the user\'s choice beats the default, both ways', () => {
    const html = renderSidebar(twoSessions(), null, null, { 's:a': true, 's:b': false });
    expect(html).toContain('f4.js');
    expect(html).toContain('data-fold="s:b" aria-expanded="false"');
  });

  it('a folded project with nothing inside shows no summary', () => {
    expect(renderSidebar(tree([]), null, null, { 'p:/r': false })).not.toContain('fold-summary');
  });

  it('singular copy', () => {
    const html = renderSidebar(tree([session('a', { files: files(1) })]), null, null, { 'p:/r': false });
    expect(html).toContain('1 sessão · 1 arquivo');
  });
});

describe('new terminal menu (#154)', () => {
  const NOW = 1_000_000_000_000;

  it('offers a plain terminal, a new chat and the chats to resume', () => {
    const html = renderNewTerminalMenu({
      conversations: [
        { sessionId: 'id-1', title: '<b>workspace</b>', updatedAt: NOW - 5 * 60_000, open: false },
        { sessionId: 'id-2', title: null, updatedAt: NOW - 3 * 3_600_000, open: true },
      ],
      now: NOW,
    });
    expect(html).toContain('data-new-kind="shell"');
    expect(html).toContain('Terminal');
    expect(html).toContain('data-new-kind="claude"');
    expect(html).toContain('Nova conversa com o Claude');
    expect(html).toContain('data-resume="id-1"');
    expect(html).toContain('&lt;b&gt;workspace&lt;/b&gt;');
    expect(html).toContain('há 5 min');
    expect(html).toContain('conversa sem título');
    expect(html).toMatch(/data-resume="id-2"[^>]*disabled/);
    expect(html).toContain('aberta em outro terminal');
    expect(html).toContain('data-new-kind="picker"');
  });

  it('a chat already in a Vizor tab is a shortcut to that tab, not a dead entry', () => {
    const html = renderNewTerminalMenu({
      conversations: [{ sessionId: 'id-3', title: 'aqui', updatedAt: NOW, open: true, tab: 'p7' }],
      now: NOW,
    });
    expect(html).toContain('data-go-tab="p7"');
    expect(html).not.toContain('data-resume="id-3"');
    expect(html).toContain('aberta numa aba');
  });

  it('says when it is loading or there is nothing to resume', () => {
    expect(renderNewTerminalMenu({ conversations: null, now: NOW })).toContain('carregando…');
    expect(renderNewTerminalMenu({ conversations: [], now: NOW })).toContain('nenhuma conversa salva nesta pasta');
  });

  it('timeAgo in pt-BR', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('agora');
    expect(timeAgo(NOW - 2 * 3_600_000, NOW)).toBe('há 2 h');
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('há 3 dias');
    expect(timeAgo(NOW - 86_400_000, NOW)).toBe('há 1 dia');
  });
});

describe('bring an outside chat into the Vizor (#156)', () => {
  it('offers it once its process is gone, explains why not otherwise', () => {
    expect(renderTerminalPlaceholder('outside', { canBring: true, why: null })).toContain('data-bring');
    const blocked = renderTerminalPlaceholder('outside', { canBring: false, why: 'ainda <aberta>' });
    expect(blocked).not.toContain('data-bring');
    expect(blocked).toContain('ainda &lt;aberta&gt;');
    expect(renderTerminalPlaceholder('outside')).not.toContain('data-bring');
  });
});
