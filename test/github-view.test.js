import { describe, it, expect } from 'vitest';
import { renderGithub, labelStyle } from '../src/renderer/github/github-view.js';

const NOW = 2_000_000_000;
const projects = [{ root: '/p/a', name: 'alpha', repo: 'o/alpha', uri: 'data:image/png;base64,AAA' }, { root: '/p/b', name: 'beta', repo: 'o/beta' }];
const issue = (over = {}) => ({ number: 7, title: 'Bug', labels: [{ name: 'bug', color: 'd73a4a' }], assignees: [{ login: 'ana' }], url: 'u', ...over });
const pr = (over = {}) => ({ number: 9, title: 'Fix', author: { login: 'bob' }, isDraft: false, headRefName: 'fix/x', reviewDecision: 'APPROVED', checks: 'ok', labels: [], ...over });
const data = (over = {}) => ({ issues: [issue()], mine: [issue()], prs: [pr()], at: NOW - 2 * 60000, ...over });
const render = (over = {}) => renderGithub({ project: '/p/a', projects, data: data(), now: NOW, ...over });

describe('renderGithub', () => {
  it('renders both lists, the picker and the age', () => {
    const html = render();
    expect(html).toContain('data-gh-section="issues"');
    expect(html).toContain('data-gh-section="prs"');
    expect(html).toContain('data-gh-project="/p/b"');
    expect(html).toContain('atualizado há 2 min');
    expect(html).toContain('✓');
    expect(html).toContain('aprovada');
    expect(html).toContain('fix/x');
  });
  it('shows the linked chat badge only for linked issues', () => {
    expect(render({ chats: { 7: { state: 'trabalhando' } } })).toContain('chat: trabalhando');
    expect(render()).not.toContain('gh-chat');
  });
  it('shows an error per list without blanking the other', () => {
    const html = render({ data: data({ prs: { error: 'boom <b>' } }) });
    expect(html).toContain('não deu pra ler as PRs: boom &lt;b&gt;');
    expect(html).toContain('#7');
  });
  it('empty lists and no-GitHub states', () => {
    expect(render({ data: data({ issues: [], mine: [], prs: [] }) })).toContain('nenhuma issue aberta');
    expect(render({ projects: [] })).toContain('esse projeto não está no GitHub');
  });
  it('shows skeletons while there is no data', () => {
    expect(render({ data: null })).toContain('skeleton');
  });
  it('filters: mine, unassigned, label, accent-insensitive text', () => {
    const d = data({ issues: [issue(), issue({ number: 8, title: 'Ação rápida', assignees: [], labels: [] })], mine: [issue()] });
    expect(render({ data: d, filter: { mine: true } })).not.toContain('data-gh-number="8"');
    expect(render({ data: d, filter: { unassigned: true } })).not.toContain('data-gh-number="7"');
    expect(render({ data: d, filter: { label: 'bug' } })).not.toContain('data-gh-number="8"');
    expect(render({ data: d, filter: { text: 'ACAO' } })).not.toContain('data-gh-number="7"');
  });
  it('escapes every field and ignores a hostile label colour', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = render({
      data: data({ issues: [issue({ title: evil, labels: [{ name: evil, color: evil }], assignees: [{ login: evil }] })], prs: [pr({ title: evil, author: { login: evil }, headRefName: evil })] }),
      projects: [{ root: '/p/a', name: evil, uri: evil, accent: evil }],
      project: '/p/a',
    });
    // the only real <img> is the project avatar, and its src stays inside the quotes
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).not.toContain(evil);
  });
  it('renders the body panel through the safe markdown', () => {
    const html = render({ selected: { kind: 'issue', number: 7 }, body: '<script>x</script> **hi**' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>hi</strong>');
    expect(render({ selected: { kind: 'issue', number: 7 }, body: null })).toContain('skeleton-body');
  });
});

describe('labelStyle', () => {
  it('picks readable text', () => {
    expect(labelStyle('ffffff')).toContain('color:#111');
    expect(labelStyle('000000')).toContain('color:#fff');
    expect(labelStyle('not-hex')).toMatch(/background:#8b949e/);
  });
});
