import { describe, it, expect } from 'vitest';
import { createCommentDelivery } from '../src/main/comment-delivery.js';
import { createCommentStore } from '../src/main/comment-store.js';
import { bracketedPaste } from '../src/main/comment-message.js';

function setup({ session = { id: 's1', status: 'done', term: { VIZOR_PTY_ID: 'p1' } }, ptyOk = true, peer = 'sent', typing = 'sent' } = {}) {
  let n = 0;
  const store = createCommentStore({ newId: () => `c${++n}` });
  const calls = { pty: [], peer: [], typing: [], clipboard: [], delays: [] };
  const current = { session };
  const delivery = createCommentDelivery({
    store,
    sessionOf: () => current.session,
    ptyUsable: () => ptyOk,
    writePty: (id, data) => calls.pty.push([id, data]),
    sendPeer: async (s, text) => {
      calls.peer.push(text);
      return peer;
    },
    typeReply: async (s, text) => {
      calls.typing.push(text);
      return typing;
    },
    copyToClipboard: (text) => calls.clipboard.push(text),
    delay: async (ms) => calls.delays.push(ms),
  });
  const add = (text) => store.add({ sessionId: 's1', editId: 'e1', text, message: `Sobre a.js (sua edição #1):\n${text}` });
  return { store, delivery, calls, add, current };
}

describe('comment delivery', () => {
  it('pastes into a live Vizor terminal, then presses Enter', async () => {
    const { delivery, calls, add, store } = setup();
    add('linha 1\nlinha 2');
    await delivery.flush('s1');
    expect(calls.pty).toEqual([
      ['p1', bracketedPaste('Sobre a.js (sua edição #1):\nlinha 1\nlinha 2')],
      ['p1', '\r'],
    ]);
    expect(calls.delays).toEqual([150]);
    expect(calls.peer).toEqual([]);
    expect(store.list('s1')[0]).toMatchObject({ status: 'sent', channel: 'pty' });
  });

  it('uses the session channel, newlines kept, when its terminal is gone', async () => {
    const { delivery, calls, add, store } = setup({ ptyOk: false });
    add('a\nb');
    await delivery.flush('s1');
    expect(calls.pty).toEqual([]);
    expect(calls.peer).toEqual(['Sobre a.js (sua edição #1):\na\nb']);
    expect(store.list('s1')[0].channel).toBe('peer');
  });

  it('falls back to typing a single line', async () => {
    const { delivery, calls, add, store } = setup({ session: { id: 's1', status: 'done', term: null }, peer: 'no-channel' });
    add('a\nb');
    await delivery.flush('s1');
    expect(calls.typing).toEqual(['Sobre a.js (sua edição #1): a b']);
    expect(store.list('s1')[0].channel).toBe('typing');
  });

  it('marks a comment failed and copies it when nothing works', async () => {
    const { delivery, calls, add, store } = setup({ ptyOk: false, peer: 'failed', typing: 'failed' });
    add('a');
    await delivery.flush('s1');
    expect(store.list('s1')[0].status).toBe('failed');
    expect(calls.clipboard).toEqual(['Sobre a.js (sua edição #1):\na']);
  });

  it('holds while the session waits and sends everything in order afterwards', async () => {
    const { delivery, calls, add, current } = setup({ ptyOk: false, session: { id: 's1', status: 'waiting', term: null } });
    add('um');
    add('dois');
    await delivery.flush('s1');
    expect(calls.peer).toEqual([]);
    current.session = { id: 's1', status: 'working', term: null };
    await delivery.flush('s1');
    expect(calls.peer.map((text) => text.split('\n')[1])).toEqual(['um', 'dois']);
  });

  it('two flushes at once deliver each comment once', async () => {
    const { delivery, calls, add } = setup({ ptyOk: false });
    add('um');
    add('dois');
    await Promise.all([delivery.flush('s1'), delivery.flush('s1')]);
    expect(calls.peer).toHaveLength(2);
  });
});
