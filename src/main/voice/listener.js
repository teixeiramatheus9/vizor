import { EventEmitter } from 'node:events';
import { createListenState } from './listen-state.js';

// Main's side of listening (#161): mic chunks go to the engine's worker
// thread (Whisper takes 0.5–0.9 s of CPU and would freeze the app and its
// terminals on the main thread); its events drive the listen-state machine,
// and each part of speech is transcribed there too.
const TRACKING = new Set(['listening', 'closing', 'grace']);

const SAMPLE_RATE = 16000;
const GAP = new Float32Array(Math.round(0.15 * SAMPLE_RATE)); // between parts in the whole

export function createListener({ worker, now = Date.now, tickMs = 100, timings, fullTranscript = true } = {}) {
  const listener = new EventEmitter();
  const machine = createListenState({ now, timings, fullTranscript });
  const audio = new Map(); // part id → its samples, for the whole-utterance transcript
  let lastState = machine.state;
  let tracking = false;

  function sync() {
    const state = machine.state;
    const wantTracking = TRACKING.has(state);
    if (wantTracking !== tracking) {
      tracking = wantTracking;
      worker.postMessage({ type: 'listen', on: tracking });
    }
    if (state !== lastState) {
      lastState = state;
      listener.emit('state', state);
    }
  }

  for (const name of ['ack', 'echo', 'utterance', 'cancelled', 'sleep', 'barge']) {
    machine.on(name, (payload) => {
      if (name === 'ack' && fullTranscript && payload?.parts?.length) {
        const pieces = payload.parts.map((id) => audio.get(id)).filter(Boolean);
        const length = pieces.reduce((sum, piece) => sum + piece.length, 0) + GAP.length * Math.max(0, pieces.length - 1);
        const whole = new Float32Array(length);
        let offset = 0;
        pieces.forEach((piece, index) => {
          if (index > 0) offset += GAP.length;
          whole.set(piece, offset);
          offset += piece.length;
        });
        worker.postMessage({ type: 'transcribe', id: `final:${payload.parts.join(',')}`, samples: whole });
      }
      if (name !== 'ack' && name !== 'echo') audio.clear();
      listener.emit(name, payload);
    });
  }

  worker.on('message', (message) => {
    switch (message?.type) {
      case 'wake':
        machine.wake();
        break;
      case 'speech-start':
        machine.speechStart();
        break;
      case 'speech-end': {
        // Each part is transcribed on its own; its text fills its slot, in
        // spoken order, whenever it comes back. A part of an ended turn has
        // no slot anymore and is ignored by the machine.
        const id = machine.speechEnd();
        if (id) {
          audio.set(id, message.samples);
          worker.postMessage({ type: 'transcribe', id, samples: message.samples });
        }
        break;
      }
      case 'transcript':
        if (String(message.id).startsWith('final:')) machine.final(message.text, message.id.slice('final:'.length));
        else machine.partial(message.text, message.id);
        break;
      case 'error':
        machine.cancel();
        listener.emit('error', message.error);
        break;
      default:
        break;
    }
    sync();
  });

  const timer = setInterval(() => {
    machine.tick();
    sync();
  }, tickMs);
  timer.unref?.();

  listener.feed = (samples) => worker.postMessage({ type: 'chunk', samples });
  listener.setVocabulary = (terms, learned) => worker.postMessage({ type: 'vocabulary', terms, learned });
  for (const name of ['speakingStarted', 'speakingEnded', 'mute', 'meeting', 'dictation', 'cancel', 'wake', 'ignoreSpeech']) {
    listener[name] = (...args) => {
      machine[name](...args);
      sync();
    };
  }
  Object.defineProperty(listener, 'state', { get: () => machine.state });
  listener.close = () => {
    clearInterval(timer);
    worker.postMessage({ type: 'close' });
    worker.terminate?.();
  };
  return listener;
}
