import { describe, expect, it } from 'vitest';
import { renderPlan } from '../src/renderer/plan-view.js';

const steps = (...done) => done.map((value, index) => ({ text: `passo ${index + 1}`, done: value }));

describe('the plan card', () => {
  it('no steps, nothing drawn', () => {
    expect(renderPlan(null)).toBe('');
    expect(renderPlan({ steps: [], approved: false })).toBe('');
  });

  it('waiting for the ok: counts, marks the first pending step and offers to approve', () => {
    const html = renderPlan({ steps: steps(false, false, false), approved: false });
    expect(html).toContain('Plano · 0/3');
    expect(html).toContain('data-plan="approve"');
    expect(html).not.toContain('data-plan="pr"');
    expect(html.match(/class="plan-step current"/g)).toHaveLength(1);
  });

  it('approved and under way: the done steps ticked, the next one current, no buttons', () => {
    const html = renderPlan({ steps: steps(true, false, false), approved: true });
    expect(html).toContain('Plano · 1/3');
    expect(html).toMatch(/class="plan-step done"[^>]*>✓/);
    expect(html).toMatch(/class="plan-step current"[^>]*>▸ <span>passo 2/);
    expect(html).not.toContain('data-plan="approve"');
    expect(html).not.toContain('data-plan="pr"');
  });

  it('every step done: offers to open the PR', () => {
    const html = renderPlan({ steps: steps(true, true), approved: true });
    expect(html).toContain('Plano · 2/2');
    expect(html).toContain('data-plan="pr"');
  });

  it('a step from the file is escaped', () => {
    const html = renderPlan({ steps: [{ text: '<img src=x onerror=alert(1)>', done: false }], approved: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
