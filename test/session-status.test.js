import { describe, it, expect } from 'vitest';
import { needsYou, blocksTyping } from '../src/main/session-status.js';

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

describe('a text question', () => {
  it('counts as needing you', () => {
    expect(needsYou({ status: 'done', question: { kind: 'text', text: 'Quer?' } })).toBe(true);
  });
  it('does not block typing into the input box, unlike a chip question or a permission ask', () => {
    expect(blocksTyping({ question: { kind: 'text', text: 'Quer?' } })).toBe(false);
    expect(blocksTyping({ question: { questions: [{}] } })).toBe(true);
    // Seen only through a Notification: the turn may not be over (an ask may follow).
    expect(blocksTyping({ question: { kind: 'text', text: 'Quer?', unconfirmed: true } })).toBe(true);
    expect(needsYou({ question: { kind: 'text', text: 'Quer?', unconfirmed: true } })).toBe(true);
    expect(blocksTyping({ needsPermission: true })).toBe(true);
    expect(blocksTyping({ question: null })).toBe(false);
  });
});
