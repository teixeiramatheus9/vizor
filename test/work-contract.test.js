import { describe, expect, it } from 'vitest';
import { findDevTodos, parseTaskPlan } from '../src/main/work/contract.js';
import { parseChecklist } from '../src/main/work/plan.js';

const SPEC = `# #169 o rótulo vzr abre o menu

## Contrato
- clique no "vzr" → abre o menu da bandeja
- sem bandeja (GNOME sem appindicator) → o clique não quebra nada

Vizor-contrato: test/tray-label.test.js
Vizor-teste: npx vitest run test/tray-label.test.js

## Passos
- [x] escrever os testes do contrato
  porquê: os dois casos viram testes do tray; o Vizor rodou e eles falham porque o rótulo não tem handler.
- [ ] [dev] decidir o que o clique faz sem bandeja
- [ ] ligar o clique no workspace.js

Vizor-plano: src/renderer/workspace.js, src/main/tray.js
`;

const withCases = (n) => `## Contrato\n${Array.from({ length: n }, (_, i) => `- caso ${i} → ok`).join('\n')}\n\n## Passos\n- [ ] a\n`;

describe('parseTaskPlan', () => {
  it('reads the whole example of the spec', () => {
    const plan = parseTaskPlan(SPEC);
    expect(plan.error).toBeNull();
    expect(plan.title).toBe('#169 o rótulo vzr abre o menu');
    expect(plan.contract).toEqual([
      { text: 'clique no "vzr" → abre o menu da bandeja' },
      { text: 'sem bandeja (GNOME sem appindicator) → o clique não quebra nada' },
    ]);
    expect(plan.contractFiles).toEqual(['test/tray-label.test.js']);
    expect(plan.testCommand).toBe('npx vitest run test/tray-label.test.js');
    expect(plan.steps).toEqual([
      { text: 'escrever os testes do contrato', done: true, why: 'os dois casos viram testes do tray; o Vizor rodou e eles falham porque o rótulo não tem handler.', dev: false },
      { text: 'decidir o que o clique faz sem bandeja', done: false, why: null, dev: true },
      { text: 'ligar o clique no workspace.js', done: false, why: null, dev: false },
    ]);
    expect(plan.planned).toEqual([{ module: 'src/renderer/workspace.js', fn: null }, { module: 'src/main/tray.js', fn: null }]);
  });

  it('a plan without Contrato is a quick task, and its checklist reads as before', () => {
    const old = '# Plano\n- [ ] Ler a issue\n- [x] Criar o menu\nVizor-plano: src/a.js';
    const plan = parseTaskPlan(old);
    expect(plan.contract).toBeNull();
    expect(plan.error).toBeNull();
    expect(plan.contractFiles).toEqual([]);
    expect(plan.testCommand).toBeNull();
    expect(plan.steps.map((s) => s.text)).toEqual(['Ler a issue', 'Criar o menu']);
    expect(parseChecklist(old)).toEqual([{ text: 'Ler a issue', done: false }, { text: 'Criar o menu', done: true }]);
  });

  it('the contract takes 2 to 6 cases, anything else is an error in pt-BR', () => {
    for (const n of [2, 6]) expect(parseTaskPlan(withCases(n)).error).toBeNull();
    for (const n of [0, 1, 7]) {
      const plan = parseTaskPlan(withCases(n));
      expect(plan.error, String(n)).toMatch(/2 a 6 casos/);
      expect(plan.contract).toHaveLength(n);
    }
  });

  it('a checkbox in the contract is no case, and a checkbox outside Passos is no step', () => {
    const plan = parseTaskPlan('## Contrato\n- a → b\n- c → d\n- [ ] não é caso\n\n## Passos\n- [ ] real\n\n## Notas\n- [ ] lembrete');
    expect(plan.contract).toHaveLength(2);
    expect(plan.steps.map((s) => s.text)).toEqual(['real']);
  });

  it('refuses test files that are absolute or climb out with ..', () => {
    for (const file of ['/etc/passwd', '../x/a.test.js', 'test/../../a.js', '~/a.js']) {
      const plan = parseTaskPlan(`${withCases(2)}\nVizor-contrato: test/ok.test.js, ${file}`);
      expect(plan.error, file).toMatch(/fora da pasta/);
      expect(plan.contractFiles).toEqual([]);
    }
    expect(parseTaskPlan(`${withCases(2)}\nVizor-contrato: \`a.test.js\`, b/c.test.js`).contractFiles).toEqual(['a.test.js', 'b/c.test.js']);
  });

  it('the test command is one line of at most 200 characters', () => {
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste: ${'x'.repeat(200)}`).error).toBeNull();
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste: ${'x'.repeat(201)}`).error).toMatch(/200/);
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste: npx vitest run \\\n  test/a.test.js`).error).toMatch(/uma linha/);
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste: npx vitest run\n  && rm -rf x`).error).toMatch(/uma linha/);
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste:   \`npm test\`  `).testCommand).toBe('npm test');
  });

  it('cuts a long why at 300 characters', () => {
    const plan = parseTaskPlan(`## Passos\n- [x] a\n  porquê: ${'y'.repeat(400)}`);
    expect(plan.steps[0].why).toHaveLength(300);
  });

  it('allows 2 [dev] steps and refuses 3', () => {
    const steps = (n) => `${withCases(2)}\n${Array.from({ length: n }, (_, i) => `- [ ] [dev] passo ${i}`).join('\n')}`;
    expect(parseTaskPlan(steps(2)).error).toBeNull();
    expect(parseTaskPlan(steps(3)).error).toMatch(/2 passos \[dev\]/);
  });
});

describe('a malformed contract never passes as a quick task', () => {
  const MALFORMED = /malformado/;
  it('flags every heading variant and stray Vizor- lines', () => {
    for (const heading of ['## Contrato:', '### Contrato', '# Contrato', '## Contrato (casos)', '## Contratos', '## contrato final']) {
      const plan = parseTaskPlan(`${heading}\n- a → b\n- c → d\n\n## Passos\n- [ ] x`);
      expect(plan.contract, heading).toBeNull();
      expect(plan.error, heading).toMatch(MALFORMED);
    }
    expect(parseTaskPlan('Vizor-contrato: a.test.js\n- [ ] x').error).toMatch(MALFORMED);
    expect(parseTaskPlan('Vizor-teste: npm test\n- [ ] x').error).toMatch(MALFORMED);
  });

  it('a plan that merely mentions the word is still a quick task', () => {
    expect(parseTaskPlan('# Plano\nler o contrato da API\n- [ ] x').error).toBeNull();
  });
});

describe('contract hardening', () => {
  it('only top-level bullets are cases', () => {
    const plan = parseTaskPlan('## Contrato\n- a → b\n  - nota sobre a\n- c → d\n\t- outra nota\n');
    expect(plan.contract).toHaveLength(2);
    expect(plan.error).toBeNull();
  });

  it('refuses a NUL byte and a backslash climb in a test path', () => {
    for (const file of ['a\0.test.js', '..\\x.test.js', 'test\\..\\..\\x.js']) {
      expect(parseTaskPlan(`${withCases(2)}\nVizor-contrato: ${file}`).error, JSON.stringify(file)).toMatch(/fora da pasta/);
    }
  });

  it('a second Vizor-teste or Vizor-contrato line is an error', () => {
    expect(parseTaskPlan(`${withCases(2)}\nVizor-teste: npm test\nVizor-teste: rm -rf x`).error).toMatch(/mais de uma/);
    expect(parseTaskPlan(`${withCases(2)}\nVizor-contrato: a.js\nVizor-contrato: b.js`).error).toMatch(/mais de uma/);
  });
});

describe('findDevTodos', () => {
  it('lists each TODO(dev) with its 1-based line and note', () => {
    const text = 'a\n  // TODO(dev): decidir o que fazer sem bandeja\nb\nTODO(dev): outra\n// TODO: comum';
    expect(findDevTodos(text)).toEqual([{ line: 2, note: 'decidir o que fazer sem bandeja' }, { line: 4, note: 'outra' }]);
    expect(findDevTodos(null)).toEqual([]);
  });
});
