import { describe, it, expect } from 'vitest';
import { buildCompilerPrompt, compileRules, parseCompilerOutput } from '../src/main/rules-compiler.js';

const LINES = ['nunca dar push na main sem me perguntar', 'nunca de drop em banco'];

describe('buildCompilerPrompt', () => {
  it('carries every line, numbered, and the match types', () => {
    const prompt = buildCompilerPrompt({ lines: LINES, scope: 'global' });
    expect(prompt).toContain('1. nunca dar push na main sem me perguntar');
    expect(prompt).toContain('2. nunca de drop em banco');
    for (const type of ['command', 'git', 'keyword', 'sql', 'tool']) expect(prompt).toContain(`"${type}"`);
  });
});

describe('parseCompilerOutput', () => {
  const good = [
    { kind: 'ask', irreversible: true, explain: 'push na principal', match: [{ type: 'git', actions: ['push'], target: 'default' }] },
    { kind: 'forbid', irreversible: true, explain: 'drop', match: [{ type: 'sql', statements: ['DROP'] }] },
  ];

  it('reads a fenced array, forcing the sources to the input lines, with stable ids', () => {
    const text = `Aqui:\n\`\`\`json\n${JSON.stringify(good.map((rule) => ({ ...rule, source: 'inventado' })))}\n\`\`\``;
    const rules = parseCompilerOutput(text, LINES, 'global');
    expect(rules.map((rule) => rule.source)).toEqual(LINES);
    expect(rules[0].id).toMatch(/^[0-9a-f]{12}$/);
    expect(parseCompilerOutput(text, LINES, 'global')[0].id).toBe(rules[0].id);
    expect(parseCompilerOutput(text, LINES, '/repo')[0].id).not.toBe(rules[0].id);
  });

  it('an unknown kind becomes a rule for the agents', () => {
    const [rule] = parseCompilerOutput(JSON.stringify([{ ...good[0], kind: 'talvez' }]), LINES.slice(0, 1), 'global');
    expect(rule).toMatchObject({ kind: 'agent', match: [], explain: 'não consegui transformar em trava' });
  });

  it('drops a broken regex, and a lock left without checks becomes an agent rule', () => {
    const [rule] = parseCompilerOutput(
      JSON.stringify([{ kind: 'forbid', irreversible: false, explain: 'x', match: [{ type: 'command', pattern: '(' }] }]),
      LINES.slice(0, 1),
      'global',
    );
    expect(rule.kind).toBe('agent');
    expect(rule.match).toEqual([]);
  });

  it('lines the answer skipped come back as agent rules', () => {
    const rules = parseCompilerOutput(JSON.stringify(good.slice(0, 1)), LINES, 'global');
    expect(rules).toHaveLength(2);
    expect(rules[1]).toMatchObject({ source: LINES[1], kind: 'agent' });
  });

  it('garbage gives null', () => {
    expect(parseCompilerOutput('não sei', LINES, 'global')).toBeNull();
  });
});

describe('compileRules', () => {
  const budget = (exceeded) => ({ isExceeded: () => exceeded, add: () => {} });

  it('does not call claude when the budget is spent', async () => {
    let called = false;
    const result = await compileRules({ lines: LINES, scope: 'global', run: async () => ((called = true), null), budget: budget(true), budgetDaily: 0 });
    expect(result).toEqual({ error: 'sem-orcamento' });
    expect(called).toBe(false);
  });

  it('asks sonnet, and reports a missing claude or a bad answer', async () => {
    let options;
    const run = async (sent) => ((options = sent), null);
    expect(await compileRules({ lines: LINES, scope: 'global', run, budget: budget(false), budgetDaily: 1 })).toEqual({ error: 'sem-claude' });
    expect(options.model).toBe('sonnet');
    expect(
      await compileRules({ lines: LINES, scope: 'global', run: async () => ({ text: 'hmm', tokens: 5 }), budget: budget(false), budgetDaily: 1 }),
    ).toEqual({ error: 'resposta-invalida' });
  });

  it('returns drafts and spends the tokens', async () => {
    let spent = 0;
    const result = await compileRules({
      lines: LINES.slice(0, 1),
      scope: 'global',
      run: async () => ({ text: JSON.stringify([{ kind: 'ask', irreversible: true, explain: 'p', match: [{ type: 'git', actions: ['push'], target: 'default' }] }]), tokens: 42 }),
      budget: { isExceeded: () => false, add: (n) => (spent += n) },
      budgetDaily: 1,
    });
    expect(result.drafts).toHaveLength(1);
    expect(spent).toBe(42);
  });
});
