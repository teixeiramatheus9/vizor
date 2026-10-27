import { describe, it, expect } from 'vitest';
import { renderKanban, skeleton } from '../src/renderer/agents/kanban-view.js';

const NOW = 1_000_000_000;
const card = (over = {}) => ({
  id: 's1', column: 'working', title: 'Tarefa', projectRoot: '/p/a', avatarKey: '/p/a', planProgress: null,
  since: NOW - 4 * 60000, question: null, branch: 'feat/x', outside: false, thin: false, actions: ['focus'], ...over,
});
const projects = { '/p/a': { name: 'alpha', uri: 'data:image/png;base64,AAA', accent: '#123456' } };

describe('renderKanban', () => {
  it('renders the five columns with titles and counts', () => {
    const html = renderKanban([card(), card({ id: 's2', column: 'waiting' })], { projects, now: NOW });
    for (const title of ['Esperando você', 'Trabalhando', 'Terminou', 'Ociosa', 'Falhou']) expect(html).toContain(title);
    expect(html.match(/data-column="\w+"><header class="kb-column-head"/g)).toHaveLength(5);
    expect(html).toContain('<span class="kb-count">1</span>');
    expect(html).toContain('há 4 min');
  });
  it('shows the empty state', () => {
    expect(renderKanban([], { now: NOW })).toContain('nenhum agente rodando');
  });
  it('shows a skeleton, not the empty state, until the first state arrives', () => {
    const html = renderKanban([], { now: NOW, loading: true });
    expect(html).toContain('skeleton');
    expect(html).not.toContain('nenhum agente rodando');
  });
  it('escapes every field', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderKanban([card({ id: evil, title: evil, branch: evil, question: evil, planProgress: evil })], {
      projects: { '/p/a': { name: evil, uri: '"><script>', accent: '"><x' }, }, now: NOW,
    });
    expect(html).not.toMatch(/<img src=x|<script|<x/);
  });
  it('badges outside and thin sessions', () => {
    const html = renderKanban([card({ outside: true, thin: true })], { projects, now: NOW });
    expect(html).toContain('fora do Vizor');
    expect(html).toContain('pouca informação');
    expect(renderKanban([card()], { projects, now: NOW })).not.toContain('fora do Vizor');
  });
  it('uses the project image, else a monogram', () => {
    expect(renderKanban([card()], { projects, now: NOW })).toContain('src="data:image/png;base64,AAA"');
    expect(renderKanban([card()], { now: NOW })).toContain('kb-avatar mono');
  });
  it('renders the guard card for a guard ask and data-action buttons', () => {
    const guardAsk = { id: 'g1', cwd: '/p/a', tool: 'Bash', summary: 'rm x', ruleSource: 'r', irreversible: false };
    const html = renderKanban([card({ column: 'waiting', guardAsk, actions: ['focus', 'guard'] })], { projects, now: NOW });
    expect(html).toContain('data-guard-card="g1"');
    expect(html).toContain('data-action="focus"');
  });
  it('filters by project and by needs-me', () => {
    const cards = [card(), card({ id: 'b', projectRoot: '/p/b', column: 'waiting' })];
    expect(renderKanban(cards, { filter: { project: '/p/b' }, now: NOW })).not.toContain('data-card="s1"');
    const needs = renderKanban(cards, { filter: { needsMe: true }, now: NOW });
    expect(needs).toContain('data-card="b"');
    expect(needs).not.toContain('data-card="s1"');
  });
  it('renders 20 cards fast', () => {
    const cards = Array.from({ length: 20 }, (_, i) => card({ id: `s${i}`, column: ['waiting', 'working', 'done', 'idle', 'failed'][i % 5], question: 'q'.repeat(200) }));
    renderKanban(cards, { projects, now: NOW });
    const start = performance.now();
    renderKanban(cards, { projects, now: NOW });
    expect(performance.now() - start).toBeLessThan(15);
  });
});

describe('hardening', () => {
  it('ignores prototype keys as actions and non-data:image avatars', () => {
    const html = renderKanban([card({ actions: ['constructor', 'focus'] })], { projects: { '/p/a': { name: 'a', uri: 'https://evil/x.png' } }, now: NOW });
    expect(html).not.toContain('data-action="constructor"');
    expect(html).not.toContain('evil');
    expect(html).toContain('kb-avatar mono');
  });
});

describe('skeleton', () => {
  it('makes the requested rows', () => {
    expect(skeleton('list', 3).match(/skeleton-row/g)).toHaveLength(3);
  });
});

describe('kanban inline states', () => {
  it('draws the reply box and the interrupt confirmation from ui', () => {
    const waiting = card({ id: 'w', column: 'waiting', actions: ['focus', 'answer'], question: 'Qual?' });
    const reply = renderKanban([waiting], { projects, now: NOW, ui: { answering: 'w', error: { id: 'w', text: 'não consegui enviar' } } });
    expect(reply).toContain('class="kb-reply"');
    expect(reply).toContain('não consegui enviar');
    const confirm = renderKanban([card({ actions: ['focus', 'interrupt'] })], { projects, now: NOW, ui: { confirming: 's1' } });
    expect(confirm).toContain('data-action="interrupt-confirm"');
    expect(confirm).not.toContain('data-action="interrupt" ');
  });
  it('keeps "outros" for chats outside every project', () => {
    const html = renderKanban([card(), card({ id: 'o', projectRoot: null, avatarKey: '/x/y', title: 'Solta' })], { filter: { project: '__other__' }, projects, now: NOW });
    expect(html).toContain('Solta');
    expect(html).not.toContain('>Tarefa<');
  });
});
