import { EventEmitter } from 'node:events';

// When the user has finished talking (#161). Pure: an injected clock, inputs
// from the engine (wake, speech start/end) and from the transcriber (partial),
// and events out: 'ack' (say "ok"), 'echo' (show the text), 'utterance' (act
// on it), 'cancelled', 'sleep', 'barge' (the user cut the Vizor's speech).
//
// Timings count from the VAD's speech-end event, which already waited 0.3 s
// of silence. "ok" never waits for the transcript (Whisper takes 0.5–0.9 s):
// a phrase hanging on a connective only waits longer when its text arrived
// in time; otherwise the grace window is what lets the user go on.
// partial(text) carries only what was said since the last pause.
export const DEFAULT_TIMINGS = { completeMs: 400, trailingMs: 1700, graceMs: 1500 };
const IDLE_MS = 8000;
const TRAILING = new Set(['e', 'tipo', 'então', 'porque', 'aí', 'que', 'mas', 'ou', 'com', 'pra', 'de']);
const STOP = new Set(['para', 'cala', 'silêncio', 'cala a boca', 'chega']);
const FINISH = /[,\s]*\b(manda|pronto)[.!]?$/i;

const words = (text) => text.toLowerCase().replace(/[.,!?;:…]/g, ' ').split(/\s+/).filter(Boolean);
const join = (...parts) => parts.filter(Boolean).join(' ');

export function createListenState({ now = Date.now, timings = DEFAULT_TIMINGS } = {}) {
  const machine = new EventEmitter();
  const t = { ...DEFAULT_TIMINGS, ...timings };
  let state = 'sleeping';
  let held = ''; // earlier parts, kept when the user went on in the grace window
  let text = null; // the transcript of the part since the last pause
  let speechEndAt = 0;
  let ackAt = Infinity;
  let acked = false;
  let graceUntil = Infinity;
  let idleSince = 0;
  let userSpeaking = false;
  let dictating = false;
  let blocked = null; // 'muted' | 'meeting'
  let ignoreUntil = -Infinity; // its own "ok" coming back through the mic

  const emit = (name, payload) => machine.emit(name, payload);

  function reset(next = 'sleeping') {
    state = next;
    held = '';
    text = null;
    ackAt = Infinity;
    acked = false;
    graceUntil = Infinity;
    userSpeaking = false;
    dictating = false;
    idleSince = now();
  }

  function listen() {
    state = 'listening';
    idleSince = now();
  }

  machine.wake = () => {
    if (blocked) return;
    if (state === 'paused-speaking') {
      emit('barge');
      reset('listening');
      return;
    }
    if (state === 'sleeping') listen();
  };

  machine.speechStart = () => {
    if (!['listening', 'closing', 'grace'].includes(state)) return;
    if (now() < ignoreUntil) return;
    if (state !== 'listening') {
      held = join(held, text);
      text = null;
      ackAt = Infinity;
      acked = false;
      graceUntil = Infinity;
      state = 'listening';
    }
    userSpeaking = true;
  };

  machine.speechEnd = () => {
    if (state !== 'listening' || !userSpeaking) return;
    userSpeaking = false;
    state = 'closing';
    speechEndAt = now();
    text = null;
    acked = false;
    ackAt = dictating ? Infinity : speechEndAt + t.completeMs;
  };

  machine.partial = (raw) => {
    if (state !== 'closing' && state !== 'grace') return;
    let value = String(raw ?? '').trim();
    const said = words(value);
    if (said[0] === 'espera' || (said[0] === 'não' && said[1] === 'espera')) {
      emit('cancelled');
      reset();
      return;
    }
    if (!held && STOP.has(said.join(' '))) {
      emit('cancelled', { stopSpeaking: true });
      reset();
      return;
    }
    if (dictating) {
      if (!FINISH.test(value)) {
        text = value;
        return;
      }
      value = value.replace(FINISH, '').trim();
      dictating = false;
      ackAt = speechEndAt + t.completeMs;
    } else if (!acked && TRAILING.has(said.at(-1))) {
      ackAt = speechEndAt + t.trailingMs;
    }
    text = value;
    if (acked) emit('echo', { text: join(held, text) });
    machine.tick();
  };

  machine.tick = () => {
    const time = now();
    if (state === 'listening' && !userSpeaking && !held && time - idleSince >= IDLE_MS) {
      emit('sleep');
      reset();
      return;
    }
    if (state === 'closing' && time >= ackAt) {
      acked = true;
      state = 'grace';
      graceUntil = ackAt + t.graceMs;
      emit('ack');
      if (text !== null) emit('echo', { text: join(held, text) });
    }
    if (state === 'grace' && time >= graceUntil && text !== null) {
      const utterance = join(held, text);
      reset();
      emit('utterance', { text: utterance });
    }
  };

  machine.ignoreSpeech = (ms) => {
    ignoreUntil = now() + ms;
  };

  machine.dictation = (on) => {
    dictating = Boolean(on);
  };

  // While the Vizor speaks, the transcriber is off (it would hear itself);
  // only the wake word cuts in. Afterwards it listens for a follow-up.
  machine.speakingStarted = () => {
    if (blocked) return;
    reset('paused-speaking');
  };
  machine.speakingEnded = () => {
    if (state === 'paused-speaking') reset('listening');
  };

  machine.mute = (on) => {
    blocked = on ? 'muted' : blocked === 'muted' ? null : blocked;
    reset(blocked ?? 'sleeping');
  };
  machine.meeting = (on) => {
    blocked = on ? 'meeting' : blocked === 'meeting' ? null : blocked;
    reset(blocked ?? 'sleeping');
  };
  machine.cancel = () => {
    emit('cancelled');
    reset(blocked ?? 'sleeping');
  };

  Object.defineProperty(machine, 'state', { get: () => state });
  Object.defineProperty(machine, 'dictating', { get: () => dictating });
  return machine;
}
