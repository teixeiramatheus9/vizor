import { describe, it, expect } from 'vitest';
import { createVoiceEngine, normalizeChunk } from '../src/main/voice/engine.js';

// A fake sherpa-onnx-node: a chunk whose first sample is WAKE makes the
// spotter fire; SPEECH/SILENCE drive the VAD; segments come out on silence.
const WAKE = 0.123;
const SPEECH = 0.5;
function fakeSherpa() {
  const calls = { transcribed: [], resets: 0 };
  class KeywordSpotter {
    createStream() {
      return { pending: [], acceptWaveform({ samples }) { this.pending.push(samples[0]); } };
    }
    isReady(stream) { return stream.pending.length > 0; }
    decode(stream) { stream.last = stream.pending.shift(); }
    getResult(stream) { return { keyword: Math.abs(stream.last - WAKE) < 1e-6 ? 'VIZOR' : '' }; }
    reset() { calls.resets++; }
  }
  class Vad {
    constructor() { this.speaking = false; this.current = []; this.segments = []; }
    acceptWaveform(samples) {
      const speech = samples[0] >= SPEECH;
      if (speech) this.current.push(...samples);
      else if (this.speaking) { this.segments.push(Float32Array.from(this.current)); this.current = []; }
      this.speaking = speech;
    }
    isDetected() { return this.speaking; }
    isEmpty() { return this.segments.length === 0; }
    front(external) { if (external !== false) throw new Error('External buffers are not allowed'); return { samples: this.segments[0], start: 0 }; }
    pop() { this.segments.shift(); }
    reset() { this.segments = []; this.current = []; this.speaking = false; }
  }
  class OfflineRecognizer {
    createStream() { return { acceptWaveform({ samples }) { this.samples = samples; } }; }
    decode(stream) { calls.transcribed.push(stream.samples.length); }
    getResult() { return { text: ' abre o pty host ' }; }
  }
  return { sherpa: { KeywordSpotter, Vad, OfflineRecognizer }, calls };
}

const chunk = (value, n = 512) => new Float32Array(n).fill(value);
const PATHS = { kws: { dir: '/m/kws', keywordsFile: '/m/kw.txt' }, vad: '/m/vad.onnx', asr: { dir: '/m/base', prefix: 'base' } };

function setup() {
  const { sherpa, calls } = fakeSherpa();
  const engine = createVoiceEngine({ sherpa, paths: PATHS, normalize: false });
  const events = [];
  for (const name of ['wake', 'speech-start', 'speech-end']) engine.on(name, (payload) => events.push([name, payload?.samples?.length ?? null]));
  return { engine, events, calls };
}

describe('voice engine', () => {
  it('wakes on the keyword and only then tracks speech', () => {
    const { engine, events } = setup();
    engine.feed(chunk(SPEECH));
    engine.feed(chunk(0));
    expect(events).toEqual([]);
    engine.feed(chunk(WAKE));
    expect(events).toEqual([['wake', null]]);
  });

  it('while listening, reports speech start and each finished segment', () => {
    const { engine, events } = setup();
    engine.listen(true);
    engine.feed(chunk(SPEECH));
    engine.feed(chunk(SPEECH));
    engine.feed(chunk(0));
    expect(events).toEqual([['speech-start', null], ['speech-end', 1024]]);
  });

  it('keeps spotting the keyword while listening (barge-in), and stops tracking speech when told', () => {
    const { engine, events } = setup();
    engine.listen(true);
    engine.feed(chunk(WAKE));
    engine.listen(false);
    engine.feed(chunk(SPEECH));
    engine.feed(chunk(0));
    expect(events).toEqual([['wake', null]]);
  });

  it('transcribes with the recognizer and trims the text', () => {
    const { engine, calls } = setup();
    expect(engine.transcribe(new Float32Array(16000))).toBe('abre o pty host');
    expect(calls.transcribed).toEqual([16000]);
  });
});

describe('normalizeChunk', () => {
  it('lifts a quiet microphone, never past the gain cap, and never clips', () => {
    const state = {};
    const quiet = new Float32Array(512).fill(0.02);
    const out = normalizeChunk(quiet, state);
    expect(Math.max(...out)).toBeGreaterThan(0.1);
    expect(Math.max(...out)).toBeLessThanOrEqual(0.02 * 8 + 1e-6);
    const loud = new Float32Array(512).fill(0.9);
    expect(Math.max(...normalizeChunk(loud, state))).toBeLessThanOrEqual(1);
  });

  it('leaves silence as silence', () => {
    expect(Math.max(...normalizeChunk(new Float32Array(512), {}))).toBe(0);
  });
});
