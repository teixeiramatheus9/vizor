import { describe, it, expect } from 'vitest';
import { createListenState } from '../src/main/voice/listen-state.js';

function setup() {
  let time = 0;
  const machine = createListenState({ now: () => time });
  const events = [];
  for (const name of ['ack', 'echo', 'utterance', 'cancelled', 'sleep', 'barge'])
    machine.on(name, (payload) => events.push([name, payload ?? null]));
  const advance = (ms) => {
    time += ms;
    machine.tick();
  };
  return { machine, events, advance, names: () => events.map(([name]) => name) };
}

describe('listen state', () => {
  it('a short complete phrase: ok at 400 ms after the speech end, sent after the grace window', () => {
    const { machine, events, advance, names } = setup();
    machine.wake();
    expect(machine.state).toBe('listening');
    machine.speechStart();
    machine.speechEnd();
    machine.partial('abre o pty-host');
    advance(399);
    expect(names()).toEqual([]);
    advance(1);
    expect(names()).toEqual(['ack', 'echo']);
    expect(events[1][1]).toEqual({ text: 'abre o pty-host' });
    advance(1499);
    expect(names()).toEqual(['ack', 'echo']);
    advance(1);
    expect(events.at(-1)).toEqual(['utterance', { text: 'abre o pty-host' }]);
    expect(machine.state).toBe('sleeping');
  });

  it('a phrase hanging on "e" waits longer before the ok', () => {
    const { machine, advance, names } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('roda os testes e');
    advance(1000);
    expect(names()).toEqual([]);
    advance(700);
    expect(names()).toEqual(['ack', 'echo']);
  });

  it('a slow transcript never delays the ok; the echo follows when the text lands', () => {
    const { machine, events, advance, names } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    advance(400);
    expect(names()).toEqual(['ack']);
    advance(300);
    machine.partial('faz o rebase');
    expect(events.at(-1)).toEqual(['echo', { text: 'faz o rebase' }]);
    advance(1200);
    expect(events.at(-1)).toEqual(['utterance', { text: 'faz o rebase' }]);
  });

  it('speaking again in the grace window joins the two parts', () => {
    const { machine, events, advance, names } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('troca o bcrypt');
    advance(400);
    machine.speechStart();
    advance(3000);
    expect(names()).not.toContain('utterance');
    machine.speechEnd();
    machine.partial('pelo argon2');
    advance(400 + 1500);
    expect(events.at(-1)).toEqual(['utterance', { text: 'troca o bcrypt pelo argon2' }]);
  });

  it('"não, espera" in the grace window cancels it', () => {
    const { machine, advance, names } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('apaga a branch');
    advance(400);
    machine.speechStart();
    machine.speechEnd();
    machine.partial('não, espera');
    advance(3000);
    expect(names()).toEqual(['ack', 'echo', 'cancelled']);
    expect(machine.state).toBe('sleeping');
  });

  it('dictation ignores pauses until "manda", which is dropped', () => {
    const { machine, events, advance, names } = setup();
    machine.wake();
    machine.dictation(true);
    machine.speechStart();
    machine.speechEnd();
    machine.partial('primeiro ponto, o login');
    advance(5000);
    expect(names()).toEqual([]);
    machine.speechStart();
    machine.speechEnd();
    machine.partial('segundo, o logout. é isso, manda');
    advance(400 + 1500);
    expect(events.at(-1)).toEqual(['utterance', { text: 'primeiro ponto, o login segundo, o logout. é isso' }]);
  });

  it('while the Vizor speaks, speech is ignored and only the wake word barges in', () => {
    const { machine, advance, names } = setup();
    machine.speakingStarted();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('qualquer coisa');
    advance(3000);
    expect(names()).toEqual([]);
    machine.wake();
    expect(names()).toEqual(['barge']);
    expect(machine.state).toBe('listening');
  });

  it('after it speaks, it listens a few seconds for a follow-up without the wake word', () => {
    const { machine, advance, names } = setup();
    machine.speakingStarted();
    machine.speakingEnded();
    expect(machine.state).toBe('listening');
    advance(8000);
    expect(names()).toEqual(['sleep']);
  });

  it('ignores its own "ok" echoing back into the mic during the grace window', () => {
    const { machine, events, advance } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('abre o pty-host');
    advance(400);
    machine.ignoreSpeech(700);
    advance(100);
    machine.speechStart();
    machine.speechEnd();
    advance(1400);
    expect(events.at(-1)).toEqual(['utterance', { text: 'abre o pty-host' }]);
  });

  it('"para" while listening cancels and asks to stop speaking', () => {
    const { machine, events, advance } = setup();
    machine.wake();
    machine.speechStart();
    machine.speechEnd();
    machine.partial('para');
    advance(400);
    expect(events.at(-1)).toEqual(['cancelled', { stopSpeaking: true }]);
  });

  it('muted or in a meeting it does not wake; clearing it goes back to sleep', () => {
    const { machine, names } = setup();
    machine.meeting(true);
    machine.wake();
    expect(machine.state).toBe('meeting');
    machine.meeting(false);
    expect(machine.state).toBe('sleeping');
    machine.mute(true);
    machine.wake();
    expect(names()).toEqual([]);
    expect(machine.state).toBe('muted');
  });

  it('woken and then silent for 8 s, it goes back to sleep', () => {
    const { machine, advance, names } = setup();
    machine.wake();
    advance(8000);
    expect(names()).toEqual(['sleep']);
    expect(machine.state).toBe('sleeping');
  });
});
