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

  // Most tests pin the per-part flow; the full-transcript one asks for it.
  function setup({ fullTranscript = false } = {}) {
    const worker = fakeWorker();
    const listener = createListener({ worker, now: () => Date.now(), tickMs: 50, fullTranscript, timings: { completeMs: 400, trailingMs: 1700, graceMs: 1500 } });
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
    listener.speakingEnded({ followUp: true });
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

  it('C1: two parts whose transcripts come back out of order make one utterance in spoken order', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(10) });
    await vi.advanceTimersByTimeAsync(200);
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(10) });
    const [first, second] = worker.sent.filter((message) => message.type === 'transcribe');
    worker.reply({ type: 'transcript', id: second.id, text: 'pelo argon2' });
    worker.reply({ type: 'transcript', id: first.id, text: 'troca o bcrypt' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(events.find(([name]) => name === 'utterance')?.[1]).toEqual({ text: 'troca o bcrypt pelo argon2' });
  });

  it('I5: a worker error cancels the turn instead of leaving it stuck', async () => {
    const { worker, listener } = setup();
    const errors = [];
    listener.on('error', (error) => errors.push(error));
    worker.reply({ type: 'wake' });
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(10) });
    worker.reply({ type: 'error', error: 'whisper crashed' });
    expect(listener.state).toBe('sleeping');
    expect(errors).toEqual(['whisper crashed']);
  });

  it('at the beep, the whole utterance is transcribed at once and that text wins (live test)', async () => {
    const { worker, events } = setup({ fullTranscript: true });
    worker.reply({ type: 'wake' });
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(1000) });
    await vi.advanceTimersByTimeAsync(200);
    worker.reply({ type: 'speech-start' });
    worker.reply({ type: 'speech-end', samples: new Float32Array(500) });
    const parts = worker.sent.filter((message) => message.type === 'transcribe');
    worker.reply({ type: 'transcript', id: parts[0].id, text: 'troca o bicrypt' });
    worker.reply({ type: 'transcript', id: parts[1].id, text: 'pelo argon' });
    await vi.advanceTimersByTimeAsync(500);
    const whole = worker.sent.filter((message) => message.type === 'transcribe').at(-1);
    expect(whole.id.startsWith('final:')).toBe(true);
    expect(whole.samples.length).toBe(1000 + 500 + 2400); // a short silence between parts
    worker.reply({ type: 'transcript', id: whole.id, text: 'troca o bcrypt pelo argon2' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.find(([name]) => name === 'utterance')?.[1]).toEqual({ text: 'troca o bcrypt pelo argon2' });
  });

  it('reports state changes for the bubble', async () => {
    const { worker, events } = setup();
    worker.reply({ type: 'wake' });
    expect(events.filter(([name]) => name === 'state').map(([, state]) => state)).toEqual(['listening']);
  });
});
