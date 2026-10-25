import { EventEmitter } from 'node:events';
import { createListenState } from './listen-state.js';

// Main's side of listening (#161): mic chunks go to the engine's worker
// thread (Whisper takes 0.5–0.9 s of CPU and would freeze the app and its
// terminals on the main thread); its events drive the listen-state machine,
// and each part of speech is transcribed there too.
const TRACKING = new Set(['listening', 'closing', 'grace']);

export function createListener({ worker, now = Date.now, tickMs = 100, timings } = {}) {
  const listener = new EventEmitter();
  const machine = createListenState({ now, timings });
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
    machine.on(name, (payload) => listener.emit(name, payload));
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
        if (id) worker.postMessage({ type: 'transcribe', id, samples: message.samples });
        break;
      }
      case 'transcript':
        machine.partial(message.text, message.id);
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
