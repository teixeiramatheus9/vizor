import { describe, it, expect } from 'vitest';
import { needsYou } from '../src/main/session-status.js';

describe('needsYou', () => {
  it('is false for an idle notice that asks nothing', () => {
    expect(needsYou({ status: 'waiting', question: null, needsPermission: false })).toBe(false);
  });
  it('is true for a question, a permission ask or a guard ask', () => {
    expect(needsYou({ status: 'waiting', question: { questions: [] } })).toBe(true);
    expect(needsYou({ status: 'waiting', needsPermission: true })).toBe(true);
    expect(needsYou({ status: 'working' }, { guardAsk: { id: 'g' } })).toBe(true);
  });
});
