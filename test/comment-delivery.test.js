import { describe, it, expect } from 'vitest';
import { createCommentDelivery } from '../src/main/comment-delivery.js';
import { createCommentStore } from '../src/main/comment-store.js';
import { bracketedPaste } from '../src/main/comment-message.js';

const inside = (extra = {}) => ({ id: 's1', status: 'done', term: { VIZOR_PTY_ID: 'p1' }, ...extra });
const outside = (extra = {}) => ({ id: 's1', status: 'done', term: null, ...extra });

function setup({ session = inside(), claudeInFront = true, peer = 'sent', typing = 'typed' } = {}) {
  let n = 0;
  const store = createCommentStore({ newId: () => `c${++n}` });
  const calls = { pty: [], peer: [], typing: [] };
  const live = { session, claudeInFront };
  const delivery = createCommentDelivery({
    store,
    sessionOf: () => live.session,
    claudeInPty: () => live.claudeInFront,
    writePty: (id, data) => calls.pty.push([id, data]),
    sendPeer: async (s, text) => {
      calls.peer.push(text);
      return peer;
    },
    typeReply: async (s, text) => {
      calls.typing.push(text);
      return typing;
    },
    delay: async () => {},
  });
  const add = (text) => store.add({ sessionId: 's1', editId: 'e1', text, message: `Sobre a.js (sua edição #1):\n${text}` });
  const state = () => store.list('s1').map((comment) => [comment.status, comment.channel]);
  return { store, delivery, calls, add, live, state };
}

describe('comment delivery (#95, after review)', () => {
  it('pastes into the Vizor terminal when claude is the job in front and idle', async () => {
    const { delivery, calls, add, state } = setup();
    add('linha 1\nlinha 2');
    await delivery.flush('s1', { immediate: true });
    expect(calls.pty).toEqual([
      ['p1', bracketedPaste('Sobre a.js (sua edição #1):\nlinha 1\nlinha 2')],
      ['p1', '\r'],
    ]);
    expect(state()).toEqual([['sent', 'pty']]);
  });

  it('idle "waiting for your input" is no reason to hold', async () => {
    const { delivery, calls, add } = setup({ session: inside({ status: 'waiting' }) });
    add('oi');
    await delivery.flush('s1');
    expect(calls.pty).toHaveLength(2);
  });

  it('never presses Enter if claude left the front between the paste and Enter', async () => {
    const { delivery, calls, add, live, state } = setup();
    const original = live;
    let checks = 0;
    original.claudeInFront = true;
    const delivery2 = delivery;
    // second check (before Enter) fails
    Object.defineProperty(live, 'claudeInFront', { get: () => ++checks < 2 });
    add('oi');
    await delivery2.flush('s1', { immediate: true });
    expect(calls.pty.map(([, data]) => data)).not.toContain('\r');
    expect(state()[0][0]).toBe('failed');
  });

  it('while a turn runs, only the session channel — never the terminal', async () => {
    const { delivery, calls, add, state } = setup({ session: inside({ status: 'working' }) });
    add('oi');
    await delivery.flush('s1', { immediate: true });
    expect(calls.pty).toEqual([]);
    expect(calls.peer).toHaveLength(1);
    expect(state()).toEqual([['sent', 'peer']]);
  });

  it('while a turn runs without a session channel, it waits for the turn to end', async () => {
    const { delivery, calls, add, live, state } = setup({ session: inside({ status: 'working' }), peer: 'no-channel' });
    add('oi');
    await delivery.flush('s1', { immediate: true });
    expect(calls.typing).toEqual([]);
    expect(state()).toEqual([['queued', null]]);
    live.session = inside({ status: 'done' });
    await delivery.flush('s1');
    expect(state()).toEqual([['sent', 'pty']]);
  });

  it('never types for a session that runs in the Vizor', async () => {
    const { delivery, calls, add, state } = setup({ claudeInFront: false, peer: 'no-channel' });
    add('oi');
    await delivery.flush('s1', { immediate: true });
    expect(calls.typing).toEqual([]);
    expect(state()[0][0]).toBe('failed');
  });

  it('types into an outside terminal only on the immediate send, flattened', async () => {
    const { delivery, calls, add, state } = setup({ session: outside(), peer: 'no-channel' });
    add('a\nb');
    await delivery.flush('s1', { immediate: true });
    expect(calls.typing).toEqual(['Sobre a.js (sua edição #1): a b']);
    expect(state()).toEqual([['sent', 'typing']]);
  });

  it('a deferred delivery never types into a window', async () => {
    const { delivery, calls, add, state } = setup({ session: outside(), peer: 'no-channel' });
    add('a');
    await delivery.flush('s1');
    expect(calls.typing).toEqual([]);
    expect(state()[0][0]).toBe('failed');
  });

  it('a typing fallback that only copied is reported as copied', async () => {
    const { delivery, add, state } = setup({ session: outside(), peer: 'no-channel', typing: 'clipboard' });
    add('a');
    await delivery.flush('s1', { immediate: true });
    expect(state()[0][0]).toBe('copied');
  });

  it('holds while a permission prompt is open and sends in order once it closes', async () => {
    const { delivery, calls, add, live } = setup({ session: outside({ status: 'waiting', needsPermission: true }) });
    add('um');
    add('dois');
    await delivery.flush('s1', { immediate: true });
    expect(calls.peer).toEqual([]);
    live.session = outside({ status: 'done' });
    await delivery.flush('s1');
    expect(calls.peer.map((text) => text.split('\n')[1])).toEqual(['um', 'dois']);
  });

  it('two flushes at once deliver each comment once', async () => {
    const { delivery, calls, add } = setup({ session: outside() });
    add('um');
    add('dois');
    await Promise.all([delivery.flush('s1'), delivery.flush('s1')]);
    expect(calls.peer).toHaveLength(2);
  });
});
