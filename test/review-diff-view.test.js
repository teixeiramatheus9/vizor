import { describe, expect, it } from 'vitest';
import { renderFileDiff, renderFileList } from '../src/renderer/review/diff-view.js';

const line = (kind, text, oldNo, newNo) => ({ kind, text, oldNo, newNo });
const hunk = (over = {}) => ({
  id: 'h1', header: '@@ -1,2 +1,2 @@', committed: false, approved: false,
  lines: [line(' ', 'keep', 1, 1), line('-', 'old', 2, null), line('+', 'const new1 = 1', null, 2)], ...over,
});
const file = (over = {}) => ({ path: 'src/a.js', status: 'modified', hunks: [hunk()], tscErrors: [], ...over });

describe('the review diff', () => {
  it('renders header, numbered lines and the four hunk buttons', () => {
    const html = renderFileDiff(file());
    expect(html).toContain('@@ -1,2 +1,2 @@');
    expect(html).toContain('diff-line add');
    expect(html).toContain('diff-line del');
    expect(html).toContain('diff-line ctx');
    for (const a of ['approve', 'reject', 'comment', 'explain']) expect(html).toContain(`data-hunk-action="${a}" data-hunk-id="h1"`);
    expect(html).toContain('tok-kw');
  });
  it('a committed hunk has reject disabled with a title', () => {
    const html = renderFileDiff(file({ hunks: [hunk({ committed: true })] }));
    expect(html).toMatch(/data-hunk-action="reject"[^>]*disabled title="[^"]+"/);
    expect(html).not.toMatch(/data-hunk-action="approve"[^>]*disabled/);
  });
  it('an untracked file has reject disabled too', () => {
    expect(renderFileDiff(file({ untracked: true }))).toContain('disabled title="arquivo novo: peça pro agente apagar"');
  });
  it('escapes code in the diff', () => {
    const html = renderFileDiff(file({ hunks: [hunk({ lines: [line('+', '<script>x</script>', null, 1)] })] }), { highlight: false });
    expect(html).not.toContain('<script>');
  });
  it('over 3000 lines without forceOpen gives only the button', () => {
    const lines = Array.from({ length: 3001 }, (_, i) => line('+', `l${i}`, null, i + 1));
    const html = renderFileDiff(file({ hunks: [hunk({ lines })] }));
    expect(html).toContain('data-file-action="force-open"');
    expect(html).not.toContain('diff-line');
    expect(renderFileDiff(file({ hunks: [hunk({ lines })] }), { forceOpen: true })).toContain('diff-line add');
  });
  it('a tooBig file from the service (no hunks) still offers the button; binary and too-big notes show', () => {
    expect(renderFileDiff(file({ tooBig: true, lines: 5000, hunks: [] }))).toContain('data-file-action="force-open"');
    expect(renderFileDiff(file({ tooBig: true, lines: 5000, hunks: [] }), { forceOpen: true })).toContain('grande demais pra mostrar');
    expect(renderFileDiff(file({ binary: true, hunks: [] }))).toContain('binário');
  });
  it('a tsc error shows under its new line', () => {
    const html = renderFileDiff(file({ tscErrors: [{ line: 2, col: 5, message: 'bad <type>' }] }));
    const at = html.indexOf('tsc-error');
    expect(at).toBeGreaterThan(html.indexOf('const'));
    expect(html).toContain('bad &lt;type&gt;');
    expect(html.indexOf('diff-line del')).toBeLessThan(at);
  });
  it('1000 lines with highlight render well under budget', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => line('+', `const value${i} = "text ${i}"; // note`, null, i + 1));
    const f = file({ hunks: [hunk({ lines })] });
    renderFileDiff(f);
    const t = performance.now();
    renderFileDiff(f);
    expect(performance.now() - t).toBeLessThan(40);
  });
});

describe('the review file list', () => {
  const files = [
    { path: 'src/a.js', status: 'modified', added: 3, removed: 1, binary: false, contract: true, untracked: false },
    { path: 'src/b.js', status: 'added', added: 5, removed: 0, binary: false, contract: false, untracked: true },
    { path: 'README.md', status: 'modified', added: 1, removed: 1, binary: false, contract: false, untracked: false },
  ];
  it('groups by folder, shows +/− and the contract badge', () => {
    const html = renderFileList(files, ['src/a.js', 'src/b.js', 'README.md'], { selectedPath: 'src/b.js', approvedByFile: { 'src/a.js': { approved: 1, total: 2 } } });
    expect((html.match(/review-dir/g) ?? []).length).toBe(2);
    expect(html).toContain('+3');
    expect(html).toContain('−1');
    expect(html).toContain('contract-badge');
    expect(html).toContain('1/2');
    expect(html).toMatch(/review-file selected" data-path="src\/b.js"/);
  });
  it('filters by path', () => {
    const html = renderFileList(files, files.map((f) => f.path), { filter: 'readme' });
    expect(html).toContain('README.md');
    expect(html).not.toContain('src/a.js');
  });
});
