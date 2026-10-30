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

  it('PRs that could not be read show a disabled line in their group', () => {
    const items = buildCommands({ issues: [], chats, prsError: true });
    const row = items.find((item) => item.id === 'prs-error');
    expect(row).toMatchObject({ group: 'PRs', label: 'não consegui ler as PRs', disabled: true });
    expect(buildCommands({ issues: [], chats }).some((item) => item.id === 'prs-error')).toBe(false);
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
    expect(filterCommands(items, 'ACAO').filter((item) => item.group === 'Issues')).toHaveLength(1);
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

describe('screens in the command bar', () => {
  it('lists the four screens, and "agentes" finds the one', async () => {
    const { buildCommands, filterCommands } = await import('../src/renderer/command-bar.js');
    const items = buildCommands({});
    const screens = items.filter((item) => item.action.type === 'goto-tab');
    expect(screens.map((item) => item.action.tab)).toEqual(['workspace', 'agents', 'github', 'automations']);
    expect(filterCommands(items, 'ir pra agentes').map((item) => item.action.tab)).toEqual(['agents']);
  });
});

describe('automações in the command bar', () => {
  it('offers "nova automação" and "rodar <nome>" for the ones that can start', async () => {
    const { buildCommands, filterCommands } = await import('../src/renderer/command-bar.js');
    const automations = [
      { id: 'a1', name: 'PRs da manhã' },
      { id: 'a2', name: 'Lint', running: { startedAt: 1 } },
      { id: 'a3', name: 'Fila', queued: true },
      { id: 'a4', name: 'Travada', blockedUntilConfirm: true },
    ];
    const items = buildCommands({ automations });
    expect(items.find((item) => item.id === 'automation:new').action).toEqual({ type: 'new-automation' });
    const runs = items.filter((item) => item.action?.type === 'run-automation');
    expect(runs.map((item) => item.label)).toEqual(['Rodar PRs da manhã']);
    expect(runs[0].action).toEqual({ type: 'run-automation', id: 'a1' });
    expect(filterCommands(items, 'rodar prs').map((item) => item.id)).toEqual(['automation:run:a1']);
    expect(filterCommands(items, 'ir pra automacoes').map((item) => item.action.tab)).toEqual(['automations']);
  });
});
