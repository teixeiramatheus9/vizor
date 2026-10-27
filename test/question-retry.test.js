import { describe, it, expect } from 'vitest';
import { readSnapshotWithQuestionRetry } from '../src/main/question-retry.js';

const text = { pendingQuestion: { kind: 'text', text: 'Posso?' } };
const ask = { pendingQuestion: { questions: [{ question: 'Qual?', options: ['a'] }] } };
const none = { pendingQuestion: null };
const run = (snaps) => {
  let calls = 0;
  const read = async () => snaps[Math.min(calls++, snaps.length - 1)];
  return readSnapshotWithQuestionRetry(read, { delays: [0, 1, 1], sleep: async () => {} }).then((snapshot) => ({ snapshot, calls }));
};

describe('readSnapshotWithQuestionRetry', () => {
  it('stops at once on a real ask', async () => {
    expect((await run([ask])).calls).toBe(1);
  });
  it('keeps retrying past a text question, so a late ask wins', async () => {
    const { snapshot, calls } = await run([text, text, ask]);
    expect(snapshot.pendingQuestion.questions).toBeDefined();
    expect(calls).toBe(3);
  });
  it('accepts a text question only after the last attempt', async () => {
    const { snapshot, calls } = await run([text]);
    expect(snapshot.pendingQuestion.kind).toBe('text');
    expect(calls).toBe(3);
  });
  it('returns nothing when nothing is pending', async () => {
    expect((await run([none])).snapshot.pendingQuestion).toBeNull();
  });
});
