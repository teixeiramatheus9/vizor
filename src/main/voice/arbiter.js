import { EventEmitter } from 'node:events';

// Who speaks when (#161). One queue, by priority: 1 a direct reply to the
// user, 2 a trava card, 3 the bound chat's narration and summary, 4 other
// sessions. Nothing starts while the user is talking; a reply or a card cuts
// another session's alert, never another reply. speak(text) resolves when the
// line was said (or stopped).
const CUTTABLE = 4;

// The spotter hears "Vizor" in the Vizor's own speech (tts respells it
// "Váizor", one of the wake spellings) and would wake itself: spoken lines
// never carry the name, nor its sound-alikes.
export function withoutWakeWord(text, lang = 'pt') {
  return String(text ?? '').replace(/\bv[aá]?i?[sz]or\b/gi, lang === 'en' ? 'project' : 'projeto');
}

// lang: the voice's language, read per line (the voice can change mid-session).
export function createSpeechArbiter({ now = Date.now, speak, stop, conversationWindowMs = 120000, lang = () => 'pt' }) {
  const arbiter = new EventEmitter();
  let queue = [];
  let current = null;
  let userTalking = false;
  let lastUserTurn = -Infinity;
  let serial = 0;

  // While the user is mid-utterance only the "ok" may play: anything else
  // would pause listening and lose what they are saying.
  function next() {
    if (current || queue.length === 0) return;
    queue.sort((a, b) => a.priority - b.priority || a.serial - b.serial);
    const index = userTalking ? queue.findIndex((candidate) => candidate.kind === 'ack') : 0;
    if (index === -1) return;
    const [item] = queue.splice(index, 1);
    const wasQuiet = !arbiter.speaking;
    current = item;
    arbiter.speaking = true;
    if (wasQuiet) arbiter.emit('speaking');
    Promise.resolve(speak(withoutWakeWord(item.text, lang()), item))
      .catch(() => {})
      .then(() => {
        current = null;
        if (queue.length === 0 || userTalking) {
          arbiter.speaking = false;
          // followUp: the last line answered the user, who may reply without
          // the wake word; an alert or narration is not an invitation.
          arbiter.emit('quiet', { followUp: item.priority === 1 && item.kind !== 'ack' });
        }
        next();
      });
  }

  arbiter.speaking = false;

  // kind: 'ack' marks the short "ok" — the caller does not pause listening for it.
  arbiter.say = ({ text, priority = 3, source = null, replaceKey = null, kind = null }) => {
    if (!text) return;
    if (replaceKey) queue = queue.filter((item) => item.replaceKey !== replaceKey);
    queue.push({ text, priority, source, replaceKey, kind, serial: serial++ });
    if (current && current.priority >= CUTTABLE && priority <= 2) stop();
    next();
  };

  arbiter.userSpeaking = (talking) => {
    userTalking = Boolean(talking);
    next();
  };

  arbiter.flush = () => {
    queue = [];
    if (current) stop();
  };

  arbiter.noteUserTurn = () => {
    lastUserTurn = now();
  };

  arbiter.inConversation = () => now() - lastUserTurn <= conversationWindowMs;

  return arbiter;
}
