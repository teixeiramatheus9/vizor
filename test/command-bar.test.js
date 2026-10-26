import { describe, expect, it } from 'vitest';
import { buildCommands, filterCommands, renderCommandList } from '../src/renderer/command-bar.js';

const issues = [
  { number: 169, title: 'Menu de ação ao clicar no ícone do Vizor' },
  { number: 149, title: 'tmux dentro de uma aba conta como no Vizor?' },
];
const chats = [
  { sessionId: 's1', name: '#169 menu', status: 'working' },
  { sessionId: 's2', name: 'refactor', status: 'done' },
];

describe('the Ctrl+K command bar', () => {
  it('lists issues to pick, chats to go to, the PRs to review and the Maestro switch', () => {
    const labels = buildCommands({ issues, prs: [{ number: 166, title: 'Modo voz' }], chats, maestroOn: false }).map((item) => item.label);
    expect(labels).toContain('Puxar #169 Menu de ação ao clicar no ícone do Vizor');
    expect(labels).toContain('Ir para #169 menu');
    expect(labels).toContain('Interromper #169 menu');
    expect(labels).not.toContain('Interromper refactor'); // not working
    expect(labels).toContain('Revisar PR #166 Modo voz');
    expect(labels).toContain('Ligar o Maestro');
  });

  it('the focused chat waiting for its ok comes first; one with every step done offers the PR', () => {
    const plans = { s1: { steps: [{ text: 'a', done: false }], approved: false }, s2: { steps: [{ text: 'a', done: true }], approved: true } };
    const first = buildCommands({ issues, chats, plans, focusedId: 's1' })[0];
    expect(first).toMatchObject({ label: 'Aprovar o plano de #169 menu', action: { type: 'approve', sessionId: 's1' } });
    const pr = buildCommands({ issues, chats, plans, focusedId: 's2' })[0];
    expect(pr).toMatchObject({ label: 'Abrir a PR de refactor', action: { type: 'open-pr', sessionId: 's2' } });
  });

  it('issues that could not be read say so, the rest still works', () => {
    const items = buildCommands({ issues: [], chats, issuesError: true });
    expect(items.some((item) => item.disabled && /não deu pra ler as issues/.test(item.label))).toBe(true);
    expect(items.some((item) => item.label === 'Ir para refactor')).toBe(true);
  });

  it('while the issues load, a line says so', () => {
    const items = buildCommands({ chats, issuesLoading: true });
    expect(items.some((item) => item.disabled && /carregando as issues/.test(item.label))).toBe(true);
  });

  it('filters by every word, ignoring accents and case; a number finds its issue first', () => {
    const items = buildCommands({ issues, chats });
    expect(filterCommands(items, 'menu icone').map((item) => item.label)).toEqual(['Puxar #169 Menu de ação ao clicar no ícone do Vizor']);
    expect(filterCommands(items, '#169')[0].action).toEqual({ type: 'pick-issue', number: 169 });
    expect(filterCommands(items, '169')[0].action).toEqual({ type: 'pick-issue', number: 169 });
    expect(filterCommands(items, 'ACAO')).toHaveLength(1);
    expect(filterCommands(items, '')).toEqual(items);
    expect(filterCommands(items, 'zzz')).toEqual([]);
  });

  it('the list marks the selected item and escapes titles', () => {
    const items = buildCommands({ issues: [{ number: 1, title: '<b>x</b>' }], chats: [] });
    const html = renderCommandList(items, 0);
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('<b>x</b>');
    expect(renderCommandList([], 0)).toContain('nada encontrado');
  });
});
