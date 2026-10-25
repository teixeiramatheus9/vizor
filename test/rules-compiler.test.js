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

describe('validateEditedRule (review I7)', () => {
  const draft = { id: 'x1', source: 'linha', kind: 'forbid', irreversible: true, explain: 'e', match: [{ type: 'sql', statements: ['DROP'] }] };

  it('keeps a valid edit, with the draft id and source', async () => {
    const { validateEditedRule } = await import('../src/main/rules-compiler.js');
    const edited = validateEditedRule(draft, { kind: 'ask', irreversible: false, explain: 'pergunta', match: [{ type: 'keyword', words: ['prod'] }] });
    expect(edited).toMatchObject({ id: 'x1', source: 'linha', kind: 'ask', match: [{ type: 'keyword', words: ['prod'] }] });
  });

  it('rejects an edit that would silently stop locking', async () => {
    const { validateEditedRule } = await import('../src/main/rules-compiler.js');
    expect(validateEditedRule(draft, { kind: 'forbid', explain: 'x', match: [{ type: 'comand', pattern: 'rm' }] })).toBeNull();
    expect(validateEditedRule(draft, { kind: 'talvez', match: [] })).toBeNull();
    expect(validateEditedRule(draft, { kind: 'forbid', explain: 42, match: { type: 'sql' } })).toBeNull();
    expect(validateEditedRule(draft, null)).toBeNull();
  });

  it('an agent rule edit stays an agent rule', async () => {
    const { validateEditedRule } = await import('../src/main/rules-compiler.js');
    expect(validateEditedRule(draft, { kind: 'agent', explain: 'só instrução', match: [] })).toMatchObject({ kind: 'agent', match: [] });
  });
});

describe('regexes the guard could hang on (#165)', () => {
  const RISKY = ['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(?:x+){2,}', '(.*a){12}', '((ab)+c)+', '([a-z]+)*@'];
  const SAFE = [
    '\\bkubectl\\b.*\\bdelete\\b',
    '^git\\s+push\\s+.*--force',
    '(ab)+',
    '(?:push|merge)\\s+origin',
    '^mcp__.*__execute_sql$',
    '(a+)?b',
    '[(+*]+x',
    '\\(a+\\)+',
    'a{2,3}',
  ];

  it('nested quantifiers and overlong patterns are refused; ordinary ones pass', async () => {
    const { isRiskyRegex } = await import('../src/main/rules-compiler.js');
    for (const pattern of RISKY) expect([pattern, isRiskyRegex(pattern)]).toEqual([pattern, true]);
    for (const pattern of SAFE) expect([pattern, isRiskyRegex(pattern)]).toEqual([pattern, false]);
    expect(isRiskyRegex('a'.repeat(501))).toBe(true);
  });

  it('a compiled check with one never reaches the guard, and an edit with one is refused', async () => {
    const { validateEditedRule } = await import('../src/main/rules-compiler.js');
    const [rule] = parseCompilerOutput(
      JSON.stringify([{ kind: 'forbid', irreversible: false, explain: 'x', match: [{ type: 'command', pattern: '(a+)+$' }] }]),
      LINES.slice(0, 1),
      'global',
    );
    expect(rule.kind).toBe('agent');
    const draft = { id: 'x1', source: 'linha', kind: 'forbid', irreversible: true, explain: 'e', match: [] };
    expect(validateEditedRule(draft, { kind: 'forbid', explain: 'x', match: [{ type: 'tool', pattern: '(\\w+_?)*$' }] })).toBeNull();
  });
});
