import { describe, expect, it } from 'vitest';
import {
  APPROVE_PROMPT, CONTRACT_APPROVED_PROMPT, DEV_DONE_PROMPT, NEXT_STEP_PROMPT, OPEN_PR_PROMPT, TRUST_PROMPT,
  devStepPrompt, restoredPrompt, startIssuePrompt, taskTabTitle, undoStepPrompt,
} from '../src/main/work/prompts.js';
import { parseTaskPlan } from '../src/main/work/contract.js';

const NO_GUI = /[nN]ão abra o app, GUI nem ferramentas de X; a conferência visual fica pro dev/;

describe('what the Vizor asks a músico', () => {
  it('starting an issue asks for the plan with a contract, the steps and their why, then a wait for the contract ok', () => {
    const prompt = startIssuePrompt(169);
    expect(prompt).toContain('gh issue view 169');
    expect(prompt).toContain('.vizor/plano-169.md');
    expect(prompt).toContain('## Contrato');
    expect(prompt).toMatch(/de 2 a 6 casos/);
    expect(prompt).toContain('## Passos');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('- [x]');
    expect(prompt).toContain('porquê:');
    expect(prompt).toContain('[dev]');
    expect(prompt).toContain('Vizor-plano:');
    expect(prompt).toMatch(/espere eu aprovar o contrato/);
    expect(prompt).toMatch(NO_GUI);
  });

  it('the plan the prompt describes is one the contract parser reads', () => {
    const plan = parseTaskPlan([
      '# Menu', '', '## Contrato', '- clicar no ícone → abre o menu', '- Esc → fecha o menu', '',
      '## Passos', '- [x] Criar o menu', '  porquê: o menu é a peça nova', '- [ ] [dev] Decidir os itens', '',
      'Vizor-plano: src/menu.js',
    ].join('\n'));
    expect(plan.error).toBeNull();
    expect(plan.contract).toHaveLength(2);
    expect(plan.steps[0].why).toBe('o menu é a peça nova');
    expect(plan.steps[1].dev).toBe(true);
  });

  it('after the contract: write the tests, list them, name the command, stop', () => {
    expect(CONTRACT_APPROVED_PROMPT).toContain('Vizor-contrato:');
    expect(CONTRACT_APPROVED_PROMPT).toContain('Vizor-teste:');
    expect(CONTRACT_APPROVED_PROMPT).toMatch(/pare/);
    expect(CONTRACT_APPROVED_PROMPT).toMatch(NO_GUI);
  });

  it('step by step: only the next step, ticked with its why, then stop; a [dev] step gets a scaffold', () => {
    expect(NEXT_STEP_PROMPT).toMatch(/só o próximo passo/);
    expect(NEXT_STEP_PROMPT).toContain('porquê:');
    expect(NEXT_STEP_PROMPT).toMatch(/pare/);
    expect(NEXT_STEP_PROMPT).toMatch(NO_GUI);
    expect(devStepPrompt('Decidir os itens')).toContain('Decidir os itens');
    expect(devStepPrompt('x')).toContain('TODO(dev):');
    expect(devStepPrompt('x')).toMatch(/andaime/);
    expect(devStepPrompt('x')).toMatch(/pare/);
    expect(DEV_DONE_PROMPT).toMatch(/fiz o passo \[dev\]; rode os testes e continue/i);
    expect(TRUST_PROMPT).toMatch(/até o fim/);
  });

  it('undoing and restoring tell the chat which step and what stayed', () => {
    expect(undoStepPrompt(2, 'Criar o menu')).toMatch(/Desfaça o passo 2/);
    expect(undoStepPrompt(2, 'Criar o menu')).toContain('Criar o menu');
    const restored = restoredPrompt(3, ['src/novo.js']);
    expect(restored).toMatch(/antes do passo 3/);
    expect(restored).toContain('src/novo.js');
    expect(restoredPrompt(3, [])).not.toMatch(/ficaram/);
    for (const prompt of [DEV_DONE_PROMPT, undoStepPrompt(1, 'x'), restoredPrompt(1, [])]) expect(prompt).toMatch(NO_GUI);
    expect(startIssuePrompt(1)).toContain('Não abra o app');
  });

  it('approving tells it to go on ticking the file; the PR asks for the tests first', () => {
    expect(APPROVE_PROMPT).toContain('arquivo do plano');
    expect(OPEN_PR_PROMPT).toMatch(/testes/);
    expect(OPEN_PR_PROMPT).toMatch(/PR/);
  });

  it('the chat tab is named after its task, short', () => {
    expect(taskTabTitle(169, 'Menu de ação ao clicar no ícone do Vizor no canto superior')).toBe('#169 Menu de ação ao clicar no…');
    expect(taskTabTitle(7, 'Curto')).toBe('#7 Curto');
    expect(taskTabTitle(7, null)).toBe('#7');
  });
});
