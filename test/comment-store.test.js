import { describe, it, expect } from 'vitest';
import { createCommentStore } from '../src/main/comment-store.js';

function makeStore() {
  let clock = 0;
  let n = 0;
  return createCommentStore({ now: () => ++clock, newId: () => `c${++n}` });
}

const add = (store, text, sessionId = 's1') => store.add({ sessionId, editId: 'e1', text, message: `msg ${text}` });

describe('comment store', () => {
  it('starts every comment queued', () => {
    const store = makeStore();
    expect(add(store, 'a')).toMatchObject({ id: 'c1', status: 'queued', text: 'a', message: 'msg a', editId: 'e1' });
  });

  it('holds everything while the session waits for the user', () => {
    const store = makeStore();
    add(store, 'a');
    expect(store.nextToSend('s1', 'waiting')).toBeNull();
    expect(store.nextToSend('s1', 'working').id).toBe('c1');
  });

  it('sends one at a time, in order, each once', () => {
    const store = makeStore();
    add(store, 'a');
    add(store, 'b');
    add(store, 'c');
    const sent = [];
    for (;;) {
      const next = store.nextToSend('s1', 'done');
      if (!next) break;
      store.markSending(next.id);
      expect(store.nextToSend('s1', 'done')).toBeNull();
      store.markSent(next.id, 'pty');
      sent.push(next.text);
    }
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(store.list('s1').map((comment) => comment.status)).toEqual(['sent', 'sent', 'sent']);
    expect(store.list('s1')[0].channel).toBe('pty');
  });

  it('a failure does not block the next one', () => {
    const store = makeStore();
    add(store, 'a');
    add(store, 'b');
    store.markSending('c1');
    store.markFailed('c1');
    expect(store.list('s1')[0].status).toBe('failed');
    expect(store.nextToSend('s1', 'done').id).toBe('c2');
  });

  it('forgets a session', () => {
    const store = makeStore();
    add(store, 'a');
    store.forgetSession('s1');
    expect(store.list('s1')).toEqual([]);
  });

  it('announces every change', () => {
    const store = makeStore();
    const seen = [];
    store.on('change', ({ sessionId }) => seen.push(sessionId));
    add(store, 'a');
    store.markSending('c1');
    store.markSent('c1', 'peer');
    expect(seen).toEqual(['s1', 's1', 's1']);
  });
});
