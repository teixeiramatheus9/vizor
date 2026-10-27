import { describe, expect, it } from 'vitest';
import { excludeWithPlan, planFileName, planFileOf, isPlanEdit, parseChecklist, planProgress } from '../src/main/work/plan.js';

describe('the músico plan file', () => {
  it('reads a markdown checklist, done and pending, ignoring the rest', () => {
    const markdown = '# Plano\n\nContexto solto.\n- [ ] Ler a issue\n- [x] Criar o menu\n  * [X] item aninhado\n- normal bullet\nVizor-plano: src/a.js';
    expect(parseChecklist(markdown)).toEqual([
      { text: 'Ler a issue', done: false },
      { text: 'Criar o menu', done: true },
      { text: 'item aninhado', done: true },
    ]);
  });

  it('a plan without a checklist has no steps, a huge one is capped and its lines cut', () => {
    expect(parseChecklist('só texto, nada de checklist')).toEqual([]);
    expect(parseChecklist(null)).toEqual([]);
    const huge = Array.from({ length: 300 }, (_, index) => `- [ ] passo ${index} ${'x'.repeat(400)}`).join('\n');
    const steps = parseChecklist(huge);
    expect(steps).toHaveLength(30);
    expect(steps[0].text.length).toBe(200);
  });

  it('with sections, only the Passos section holds steps; without, every line does', () => {
    const md = '## Contrato\n- [ ] solto\n\n## Passos\n- [ ] um\n- [x] dois\n\n## Notas\n- [ ] fora';
    expect(parseChecklist(md)).toEqual([{ text: 'um', done: false }, { text: 'dois', done: true }]);
    expect(parseChecklist('## Contrato\n- [ ] sem Passos')).toEqual([{ text: 'sem Passos', done: false }]);
  });

  it('progress counts the done steps and points at the first pending one', () => {
    expect(planProgress([{ done: true }, { done: false }, { done: false }])).toEqual({ done: 1, total: 3, current: 1 });
    expect(planProgress([{ done: true }])).toEqual({ done: 1, total: 1, current: -1 });
    expect(planProgress([])).toEqual({ done: 0, total: 0, current: -1 });
  });

  it('only a write to the plan file at the session root counts, never one elsewhere', () => {
    const at = (file, tool = 'Write') => ({ hook_event_name: 'PostToolUse', tool_name: tool, cwd: '/repo', tool_input: { file_path: file } });
    expect(isPlanEdit(at('/repo/.vizor/plano.md'))).toBe(true);
    expect(isPlanEdit(at('.vizor/plano.md', 'Edit'))).toBe(true);
    expect(isPlanEdit(at('/repo/.vizor/plano.md', 'MultiEdit'))).toBe(true);
    expect(isPlanEdit(at('/repo/docs/.vizor/plano.md'))).toBe(false);
    expect(isPlanEdit(at('/repo/../x/.vizor/plano.md'))).toBe(false);
    expect(isPlanEdit(at('/repo/.vizor/plano.md', 'Read'))).toBe(false);
    expect(isPlanEdit({ ...at('/repo/.vizor/plano.md'), cwd: undefined })).toBe(false);
    expect(isPlanEdit(at('/repo/.vizor/plano-169.md'))).toBe(true);
    expect(isPlanEdit(at('/repo/.vizor/plano-../x.md'))).toBe(false);
    expect(planFileOf(at('/repo/.vizor/plano-169.md'))).toBe('plano-169.md');
    expect(planFileOf(at('/repo/src/a.js'))).toBeNull();
    expect(planFileName(169)).toBe('.vizor/plano-169.md');
  });

  it('the git exclude gains .vizor/ once', () => {
    expect(excludeWithPlan('# git ls-files --others --exclude-from=.git/info/exclude\n')).toBe(
      '# git ls-files --others --exclude-from=.git/info/exclude\n.vizor/\n',
    );
    expect(excludeWithPlan('')).toBe('.vizor/\n');
    expect(excludeWithPlan('node_modules')).toBe('node_modules\n.vizor/\n');
    expect(excludeWithPlan('a\n.vizor/\n')).toBeNull();
  });
});
