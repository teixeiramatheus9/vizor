import { EventEmitter } from 'node:events';

// When the user has finished talking (#161). Pure: an injected clock, inputs
// from the engine (wake, speech start/end) and from the transcriber (partial),
// and events out: 'ack' (say "ok"), 'echo' (show the text), 'utterance' (act
// on it), 'cancelled', 'sleep', 'barge' (the user cut the Vizor's speech).
//
// Each part of speech (VAD start → end) gets a slot; its transcript fills
// the slot whenever Whisper returns (0.5–0.9 s later, maybe after the user
// already went on), and the utterance is the slots joined in spoken order.
// Timings count from the VAD's speech-end event, which already waited 0.3 s
// of silence. "ok" never waits for the transcript; a phrase hanging on a
// connective only waits longer when its text arrived in time — otherwise the
// grace window is what lets the user go on.
export const DEFAULT_TIMINGS = { completeMs: 400, trailingMs: 1700, graceMs: 1500 };
const IDLE_MS = 8000;
const LOST_TRANSCRIPT_MS = 8000; // grace over and a part still has no text
const TRAILING = new Set(['e', 'tipo', 'então', 'porque', 'aí', 'que', 'mas', 'ou', 'com', 'pra', 'de']);
const STOP = new Set(['para', 'cala', 'silêncio', 'cala a boca', 'chega']);
const CANCEL = new Set(['não espera', 'espera', 'espera aí', 'não espera aí']);
const FINISH = /[,\s]*\b(manda|pronto)[.!]?$/i;

const words = (text) => text.toLowerCase().replace(/[.,!?;:…]/g, ' ').split(/\s+/).filter(Boolean);

export function createListenState({ now = Date.now, timings = DEFAULT_TIMINGS } = {}) {
  const machine = new EventEmitter();
  const t = { ...DEFAULT_TIMINGS, ...timings };
  let state = 'sleeping';
  let parts = []; // [{ id, text: string|null }] in spoken order
  let partSerial = 0;
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
  const filled = () => parts.every((part) => part.text !== null);
  const joined = () =>
    parts
      .map((part) => part.text)
      .filter(Boolean)
      .join(' ');

  function reset(next = 'sleeping', { keepDictation = false } = {}) {
    state = next;
    parts = [];
    ackAt = Infinity;
    acked = false;
    graceUntil = Infinity;
    userSpeaking = false;
    if (!keepDictation) dictating = false;
    idleSince = now();
  }

  machine.wake = () => {
    if (blocked) return;
    if (state === 'paused-speaking') {
      emit('barge');
      reset('listening');
      return;
    }
    if (state === 'sleeping') {
      state = 'listening';
      idleSince = now();
    }
  };

  machine.speechStart = () => {
    if (!['listening', 'closing', 'grace'].includes(state)) return;
    if (now() < ignoreUntil) return;
    if (state !== 'listening') {
      ackAt = Infinity;
      acked = false;
      graceUntil = Infinity;
      state = 'listening';
    }
    userSpeaking = true;
  };

  // Returns the new part's id: its transcript comes back with it.
  machine.speechEnd = () => {
    if (state !== 'listening' || !userSpeaking) return null;
    userSpeaking = false;
    state = 'closing';
    speechEndAt = now();
    const id = `p${++partSerial}`;
    parts.push({ id, text: null });
    acked = false;
    ackAt = dictating ? Infinity : speechEndAt + t.completeMs;
    return id;
  };

  machine.partial = (raw, id) => {
    if (!['listening', 'closing', 'grace'].includes(state)) return;
    const part = id ? parts.find((candidate) => candidate.id === id) : [...parts].reverse().find((candidate) => candidate.text === null);
    if (!part) return;
    let value = String(raw ?? '').trim();
    const said = words(value).join(' ');
    const isLast = part === parts.at(-1);
    if (CANCEL.has(said) && (parts.length > 1 || state === 'grace')) {
      emit('cancelled');
      reset();
      return;
    }
    if (parts.length === 1 && STOP.has(said)) {
      emit('cancelled', { stopSpeaking: true });
      reset();
      return;
    }
    if (dictating && isLast) {
      if (FINISH.test(value)) {
        value = value.replace(FINISH, '').trim();
        dictating = false;
        if (state === 'closing') ackAt = speechEndAt + t.completeMs;
      }
    } else if (!acked && isLast && state === 'closing' && TRAILING.has(words(value).at(-1))) {
      ackAt = speechEndAt + t.trailingMs;
    }
    part.text = value;
    if (acked && filled()) emit('echo', { text: joined() });
    machine.tick();
  };

  machine.tick = () => {
    const time = now();
    if (state === 'listening' && !userSpeaking && parts.length === 0 && time - idleSince >= IDLE_MS) {
      emit('sleep');
      reset();
      return;
    }
    if (state === 'closing' && time >= ackAt) {
      acked = true;
      state = 'grace';
      graceUntil = ackAt + t.graceMs;
      emit('ack');
      if (filled()) emit('echo', { text: joined() });
    }
    if (state === 'grace' && time >= graceUntil) {
      if (filled()) {
        const utterance = joined();
        reset();
        emit('utterance', { text: utterance });
      } else if (time >= graceUntil + LOST_TRANSCRIPT_MS) {
        emit('cancelled');
        reset();
      }
    }
  };

  machine.ignoreSpeech = (ms) => {
    ignoreUntil = now() + ms;
  };

  machine.dictation = (on) => {
    dictating = Boolean(on);
  };

  // While the Vizor speaks, the transcriber is off (it would hear itself);
  // only the wake word cuts in. A user mid-sentence is never wiped: the
  // arbiter holds everything but the "ok" until the utterance is out.
  machine.speakingStarted = () => {
    if (blocked) return;
    if (state === 'closing' || state === 'grace' || (state === 'listening' && userSpeaking)) return;
    reset('paused-speaking', { keepDictation: true });
  };

  // followUp: the line answered the user, so a reply needs no wake word.
  machine.speakingEnded = ({ followUp = false } = {}) => {
    if (state !== 'paused-speaking') return;
    reset(followUp || dictating ? 'listening' : 'sleeping', { keepDictation: true });
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
