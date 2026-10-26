import { describe, expect, it } from 'vitest';
import { APPROVE_PROMPT, OPEN_PR_PROMPT, startIssuePrompt, taskTabTitle } from '../src/main/work/prompts.js';

describe('what the Vizor asks a músico', () => {
  it('starting an issue asks for the plan as a checklist file, then a wait for the ok', () => {
    const prompt = startIssuePrompt(169);
    expect(prompt).toContain('gh issue view 169');
    expect(prompt).toContain('.vizor/plano-169.md');
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('- [x]');
    expect(prompt).toContain('Vizor-plano:');
    expect(prompt).toMatch(/espere meu ok/);
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
