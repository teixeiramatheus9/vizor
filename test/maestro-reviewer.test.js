import { describe, expect, it } from 'vitest';
import { REVIEW_TASK_PROMPT, shouldSuggest } from '../src/main/maestro/reviewer.js';

const critical = { modules: new Set(['src/hub.js']), functions: new Set() };
const impact = (modules) => ({ sessionId: 's22', modules, functions: {} });

describe('when the reviewer is offered', () => {
  it('three touched files, or one critical, suggest a reviewer', () => {
    expect(shouldSuggest(impact({ 'a.js': 'touched', 'b.js': 'touched', 'c.js': 'touched' }), critical, new Set())).toEqual({ touched: 3, critical: 0 });
    expect(shouldSuggest(impact({ 'src/hub.js': 'touched' }), critical, new Set())).toEqual({ touched: 1, critical: 1 });
    expect(shouldSuggest(impact({ 'a.js': 'touched', 'b.js': 'touched' }), critical, new Set())).toBeNull();
  });

  it('never twice for the same músico', () => {
    const seen = new Set(['s22']);
    expect(shouldSuggest(impact({ 'src/hub.js': 'touched' }), critical, seen)).toBeNull();
  });

  it('planned files do not count, only touched', () => {
    expect(shouldSuggest(impact({ 'a.js': 'planned', 'b.js': 'planned', 'c.js': 'planned', 'src/hub.js': 'planned' }), critical, new Set())).toBeNull();
    expect(REVIEW_TASK_PROMPT('22')).toContain('git diff');
    expect(REVIEW_TASK_PROMPT('22')).toContain('não mude código nem publique nada sem eu pedir');
  });
});
