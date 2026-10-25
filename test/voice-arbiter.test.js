import { describe, it, expect } from 'vitest';
import { createSpeechArbiter } from '../src/main/voice/arbiter.js';

function setup() {
  let time = 0;
  const spoken = [];
  const running = [];
  let stops = 0;
  const arbiter = createSpeechArbiter({
    now: () => time,
    speak: (text) =>
      new Promise((resolve) => {
        spoken.push(text);
        running.push(resolve);
      }),
    stop: () => {
      stops++;
      running.splice(0).forEach((resolve) => resolve());
    },
  });
  const finish = async () => {
    running.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const flushMicro = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { arbiter, spoken, finish, flushMicro, stops: () => stops, advance: (ms) => (time += ms) };
}

describe('speech arbiter', () => {
  it('speaks the queue in priority order', async () => {
    const { arbiter, spoken, finish } = setup();
    arbiter.userSpeaking(true);
    arbiter.say({ text: 'outra sessão', priority: 4 });
    arbiter.say({ text: 'narração', priority: 3 });
    arbiter.say({ text: 'trava', priority: 2 });
    arbiter.say({ text: 'resposta', priority: 1 });
    expect(spoken).toEqual([]);
    arbiter.userSpeaking(false);
    for (let i = 0; i < 4; i++) await finish();
    expect(spoken).toEqual(['resposta', 'trava', 'narração', 'outra sessão']);
  });

  it('never starts while the user speaks', async () => {
    const { arbiter, spoken, flushMicro } = setup();
    arbiter.userSpeaking(true);
    arbiter.say({ text: 'ok', priority: 1 });
    await flushMicro();
    expect(spoken).toEqual([]);
    arbiter.userSpeaking(false);
    await flushMicro();
    expect(spoken).toEqual(['ok']);
  });

  it('flush empties the queue and stops the current one', async () => {
    const { arbiter, spoken, finish, stops } = setup();
    arbiter.say({ text: 'a', priority: 3 });
    arbiter.say({ text: 'b', priority: 3 });
    arbiter.flush();
    expect(stops()).toBe(1);
    await finish();
    expect(spoken).toEqual(['a']);
  });

  it('a newer narration of the same chat replaces the queued older ones', async () => {
    const { arbiter, spoken, finish } = setup();
    arbiter.say({ text: 'primeira', priority: 3 });
    for (let i = 0; i < 10; i++) arbiter.say({ text: `mexendo ${i}`, priority: 3, replaceKey: 'chat-22' });
    await finish();
    await finish();
    expect(spoken).toEqual(['primeira', 'mexendo 9']);
  });

  it('a reply or a trava card cuts another session’s alert, not another reply', async () => {
    const { arbiter, spoken, stops, flushMicro } = setup();
    arbiter.say({ text: 'o chat X terminou', priority: 4 });
    arbiter.say({ text: 'posso seguir?', priority: 2 });
    expect(stops()).toBe(1);
    await flushMicro();
    expect(spoken).toEqual(['o chat X terminou', 'posso seguir?']);
    arbiter.say({ text: 'ok', priority: 1 });
    expect(stops()).toBe(1);
  });

  it('hands speak the whole item, so the caller can tell an ok from a reply', async () => {
    const seen = [];
    const arbiter = createSpeechArbiter({ speak: (text, item) => (seen.push(item.kind ?? null), Promise.resolve()), stop: () => {} });
    arbiter.say({ text: 'ok', priority: 1, kind: 'ack' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['ack']);
  });

  it('knows when a conversation is going on', () => {
    const { arbiter, advance } = setup();
    expect(arbiter.inConversation()).toBe(false);
    arbiter.noteUserTurn();
    advance(119000);
    expect(arbiter.inConversation()).toBe(true);
    advance(2000);
    expect(arbiter.inConversation()).toBe(false);
  });

  it('tells when it starts and when it goes quiet', async () => {
    const { arbiter, finish } = setup();
    const events = [];
    arbiter.on('speaking', () => events.push('speaking'));
    arbiter.on('quiet', () => events.push('quiet'));
    arbiter.say({ text: 'a', priority: 1 });
    arbiter.say({ text: 'b', priority: 1 });
    await finish();
    await finish();
    expect(events).toEqual(['speaking', 'quiet']);
  });
});
