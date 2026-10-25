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
  let pendingId = null;
  let counter = 0;

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

  // The ok comes before the transcript on purpose; only an ended turn drops
  // the transcript still on its way.
  const ENDS_TURN = new Set(['utterance', 'cancelled', 'sleep', 'barge']);
  for (const name of ['ack', 'echo', 'utterance', 'cancelled', 'sleep', 'barge']) {
    machine.on(name, (payload) => {
      if (ENDS_TURN.has(name)) pendingId = null;
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
        machine.speechEnd();
        pendingId = `t${++counter}`;
        worker.postMessage({ type: 'transcribe', id: pendingId, samples: message.samples });
        break;
      }
      case 'transcript':
        // Only the latest part's text counts: an older one belongs to a
        // part the machine already moved past.
        if (message.id === pendingId) machine.partial(message.text);
        break;
      case 'error':
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
