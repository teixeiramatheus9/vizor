import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createListener } from '../src/main/voice/listener.js';

// A fake worker: records what main posts, and lets the test post back.
function fakeWorker() {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.postMessage = (message) => worker.sent.push(message);
  worker.terminate = vi.fn();
  worker.reply = (message) => worker.emit('message', message);
  return worker;
}

describe('listener', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const worker = fakeWorker();
    const listener = createListener({ worker, now: () => Date.now(), tickMs: 50 });
    const events = [];
    for (const name of ['ack', 'echo', 'utterance', 'state']) listener.on(name, (payload) => events.push([name, payload]));
    return { worker, listener, events };
  }
  const listens = (worker) => worker.sent.filter((message) => message.type === 'listen').map((message) => message.on);

  it('forwards mic chunks to the worker', () => {
    const { worker, listener } = setup();
    listener.feed(new Float32Array(160));
    expect(worker.sent[0]).toMatchObject({ type: 'chunk' });
    expect(worker.sent[0].samples).toHaveLength(160);
  });

  it('turns voice tracking on at the wake word, transcribes each part, and emits the utterance', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    expect(listens(worker)).toEqual([true]);
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(8000) });
    const request = worker.sent.find((message) => message.type === 'transcribe');
    expect(request.samples).toHaveLength(8000);
    worker.reply({ type: 'transcript', id: request.id, text: 'abre o pty host' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.map(([name]) => name)).toEqual(expect.arrayContaining(['ack', 'echo', 'utterance']));
    expect(events.find(([name]) => name === 'utterance')[1]).toEqual({ text: 'abre o pty host' });
    expect(listens(worker).at(-1)).toBe(false);
  });

  it('stops tracking voice while the Vizor speaks, and listens for a follow-up after', () => {
    const { worker, listener } = setup();
    worker.reply({ type: 'wake' });
    listener.speakingStarted();
    expect(listens(worker).at(-1)).toBe(false);
    listener.speakingEnded();
    expect(listens(worker).at(-1)).toBe(true);
  });

  it('a transcript from a part already dropped is ignored', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(10) });
    const first = worker.sent.find((message) => message.type === 'transcribe');
    worker.reply({ type: 'transcript', id: 'nope', text: 'outra coisa' });
    worker.reply({ type: 'transcript', id: first.id, text: 'certo' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.find(([name]) => name === 'utterance')[1]).toEqual({ text: 'certo' });
  });

  it('a transcript that lands after the ok still becomes the utterance (Whisper is slower than the ok)', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(10) });
    const request = worker.sent.find((message) => message.type === 'transcribe');
    await vi.advanceTimersByTimeAsync(600);
    expect(events.map(([name]) => name)).toContain('ack');
    worker.reply({ type: 'transcript', id: request.id, text: 'troca pelo argon 2' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.find(([name]) => name === 'utterance')?.[1]).toEqual({ text: 'troca pelo argon 2' });
  });

  it('reports state changes for the bubble', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    expect(events.filter(([name]) => name === 'state').map(([, state]) => state)).toEqual(['listening']);
  });
});
