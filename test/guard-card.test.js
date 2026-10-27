import { describe, it, expect } from 'vitest';
import { guardSpeech, renderGuardCard } from '../src/renderer/guard-card.js';

const ask = (overrides = {}) => ({
  id: 'a1',
  sessionId: 's1',
  cwd: '/home/u/vizor',
  tool: 'Bash',
  summary: 'kubectl --context prod apply',
  ruleSource: 'quando ver PROD pergunte',
  explain: 'menciona PROD',
  irreversible: false,
  at: 0,
  ...overrides,
});

describe('renderGuardCard', () => {
  it('shows the project, the call, the rule and the three choices', () => {
    const html = renderGuardCard(ask());
    expect(html).toContain('Posso seguir?');
    expect(html).toContain('vizor');
    expect(html).toContain('kubectl --context prod apply');
    expect(html).toContain('regra: quando ver PROD pergunte');
    for (const choice of ['liberar', 'liberar-sessao', 'barrar']) expect(html).toContain(`data-guard-choice="${choice}"`);
    expect(html).toContain('data-guard-id="a1"');
    expect(html).toContain('Liberar nesta sessão');
  });

  it('an irreversible ask has no session grant and says why', () => {
    const html = renderGuardCard(ask({ irreversible: true }));
    expect(html).not.toContain('liberar-sessao');
    expect(html).toContain('isso não tem volta — pergunto sempre');
  });

  it('an automação ask has no session grant', () => {
    const html = renderGuardCard(ask({ automationId: 'auto-1' }));
    expect(html).not.toContain('liberar-sessao');
    expect(html).toContain('data-guard-choice="liberar"');
    expect(html).toContain('data-guard-choice="barrar"');
  });

  it('escapes everything that came from the hook', () => {
    const html = renderGuardCard(ask({ summary: '<script>x</script>', ruleSource: '"><img>', id: '"x' }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><img>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('guardSpeech', () => {
  it('is short and asks', () => {
    expect(guardSpeech(ask())).toBe('Um Claude no vizor quer rodar kubectl --context prod apply. Posso seguir?');
    expect(guardSpeech(ask({ tool: 'Edit', summary: 'Edit /home/u/vizor/config/prod.env' }))).toBe(
      'Um Claude no vizor quer mexer em prod.env. Posso seguir?',
    );
  });
});

describe('guardSpeech in English, for an English voice', () => {
  it('a command and a file edit', () => {
    expect(guardSpeech({ cwd: '/r/vizor', tool: 'Bash', summary: 'git push --force' }, 'en')).toBe('A Claude in vizor wants to run git push --force. Can I go ahead?');
    expect(guardSpeech({ cwd: '/r/vizor', tool: 'Edit', summary: 'Edit /r/vizor/.env' }, 'en')).toBe('A Claude in vizor wants to edit .env. Can I go ahead?');
    expect(guardSpeech({ cwd: '', tool: 'Bash', summary: 'rm x' }, 'en')).toBe('A Claude in a project wants to run rm x. Can I go ahead?');
  });
});
