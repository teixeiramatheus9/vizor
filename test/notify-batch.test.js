import { describe, it, expect, vi } from 'vitest';
import { createNotifyBatch, summarizeBatch, isUrgent } from '../src/main/notify-batch.js';

function harness() {
  const flushed = [];
  let pendingTimer = null;
  const setTimeout = vi.fn((fn, ms) => {
    pendingTimer = { fn, ms };
    return 1;
  });
  const clearTimeout = vi.fn(() => {
    pendingTimer = null;
  });
  const batch = createNotifyBatch({ windowMs: 3000, setTimeout, clearTimeout, flush: (events) => flushed.push(events) });
  return { batch, flushed, setTimeout, fire: () => pendingTimer?.fn() };
}

describe('notify batch', () => {
  it('groups 10 events into one flush after the window', () => {
    const { batch, flushed, setTimeout, fire } = harness();
    for (let i = 0; i < 10; i++) batch.push({ kind: 'done', sessionId: `s${i}` });
    expect(flushed).toHaveLength(0);
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout.mock.calls[0][1]).toBe(3000);
    fire();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(10);
    expect(batch.pendingCount()).toBe(0);
  });

  it('lets an urgent event through at once, leaving the rest waiting', () => {
    const { batch, flushed, fire } = harness();
    batch.push({ kind: 'done', sessionId: 'a' });
    batch.push({ kind: 'question', sessionId: 'b' });
    expect(flushed).toEqual([[{ kind: 'question', sessionId: 'b' }]]);
    fire();
    expect(flushed[1]).toEqual([{ kind: 'done', sessionId: 'a' }]);
  });

  it('batches the 10 minute reminder but not a fresh waiting', () => {
    expect(isUrgent({ kind: 'waiting' })).toBe(true);
    expect(isUrgent({ kind: 'waiting', reminder: true })).toBe(false);
    expect(isUrgent({ kind: 'permission' })).toBe(true);
    expect(isUrgent({ kind: 'done' })).toBe(false);
  });

  it('starts a new window after a flush', () => {
    const { batch, flushed, fire } = harness();
    batch.push({ kind: 'done' });
    fire();
    batch.push({ kind: 'done' });
    fire();
    expect(flushed).toHaveLength(2);
  });

  it('cancel drops what waits and the timer', () => {
    const { batch, flushed, fire } = harness();
    batch.push({ kind: 'done' });
    batch.cancel();
    fire();
    expect(flushed).toHaveLength(0);
  });
});

describe('summarizeBatch', () => {
  it('says how many chats finished', () => {
    expect(summarizeBatch([{ kind: 'done' }, { kind: 'done' }, { kind: 'done' }])).toMatchObject({ kind: 'done', text: '3 chats terminaram' });
  });
  it('flags waiting ones', () => {
    expect(summarizeBatch([{ kind: 'waiting' }, { kind: 'waiting' }]).kind).toBe('waiting');
    expect(summarizeBatch([{ kind: 'waiting' }, { kind: 'done' }])).toMatchObject({ kind: 'waiting', text: '2 chats mudaram de estado, 1 esperando você' });
  });
});
