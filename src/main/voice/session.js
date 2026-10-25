import { routeUtterance } from './commands.js';
import { analyzeReply, createReplyCursor, spokenReply } from './replies.js';
import { createNarrator } from './narration.js';
import { closestPhrase } from './vocabulary.js';

// The voice conversation (#161): who the voice talks to (the gerente or one
// chat), what each utterance does, and what comes back spoken. Every side
// effect is an injected dep, so the whole scene is tested with fakes.
const SAY_MAX = 160;
const PROPOSAL = /quer que eu retome a (?:task |tarefa |issue )?#?(\d+)/i;
const GUARD_SAID = { liberar: 'Liberado.', 'liberar-sessao': 'Liberado nesta sessão.', barrar: 'Barrado.' };

const firstSentence = (text) => {
  const sentence = (String(text ?? '').match(/^[^.!?\n]*[.!?]?/) ?? [''])[0].trim();
  return sentence.length > SAY_MAX ? `${sentence.slice(0, SAY_MAX).replace(/\s+\S*$/, '')}…` : sentence;
};
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`);

export function createVoiceSession(deps) {
  const narrator = createNarrator();
  let target = { kind: 'manager' };
  let boundTask = null; // the task number the bound chat was opened for
  let cursor = null;
  let pendingConfirm = null;
  let pendingAsk = false;
  let lastHeard = null;
  let queuedPrompt = null;

  // A voice reads emoji out loud ("rosto suando"): they never reach it.
  const speakable = (text) => String(text ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim();
  const say = (text, priority = 1, extra = {}) => {
    const clean = speakable(text);
    if (clean) deps.say({ text: clean, priority, ...extra });
  };

  function bind(sessionId, number = null) {
    target = { kind: 'chat', sessionId };
    boundTask = number;
    cursor = null;
    queuedPrompt = null;
  }

  async function resumeTask(number) {
    const found = await deps.resolveTask(number);
    if (found.sessionId) {
      const opened = await deps.openOrFocus({ sessionId: found.sessionId, cwd: found.cwd });
      const sessionId = opened?.sessionId ?? found.sessionId;
      deps.linkTask(number, sessionId);
      bind(sessionId, number);
      const info = deps.sessionInfo(sessionId) ?? {};
      const where = info.lastMessage ? ` ${firstSentence(info.lastMessage)}` : '';
      say(`Abri a ${number}${info.title ? `, ${info.title}` : ''}.${where}`);
      return;
    }
    if (found.candidates) {
      say(`Achei ${found.candidates.length} conversas da ${number}: ${joinNames(found.candidates.map((item) => item.title))}. Diga "fala com o chat" e o nome.`);
      return;
    }
    pendingConfirm = { kind: 'new-chat', number, cwd: found.cwd ?? deps.projectRoot() };
    say(`Não achei conversa da ${number}. Abro um chat novo pra ela?`);
  }

  async function confirm(yes) {
    const pending = pendingConfirm;
    pendingConfirm = null;
    if (!yes) {
      say('Beleza.');
      return;
    }
    if (pending.kind === 'new-chat') {
      const opened = await deps.openNew({ cwd: pending.cwd, prompt: `Vamos trabalhar na issue #${pending.number}.` });
      deps.linkTask(pending.number, opened.sessionId);
      bind(opened.sessionId, pending.number);
      say(`Abri um chat novo pra ${pending.number}.`);
    } else if (pending.kind === 'learn') {
      deps.learn({ heard: pending.heard, meant: pending.meant });
      say('Salvo.');
    } else if (pending.kind === 'intent') {
      await act(pending.intent, '');
    }
  }

  async function act(intent, raw) {
    switch (intent.type) {
      case 'status': {
        const digest = await deps.ghDigest();
        say(digest.speech);
        deps.showLines(digest.lines);
        return;
      }
      case 'resume-task':
        return resumeTask(intent.number);
      case 'talk-to-chat': {
        const sessionId = deps.findChat(intent.query);
        if (!sessionId) return say('Não achei esse chat.');
        bind(sessionId);
        return say(`Falando com o chat ${deps.sessionInfo(sessionId)?.title ?? intent.query}.`);
      }
      case 'talk-to-manager':
        target = { kind: 'manager' };
        return say('Voltei pro gerente.');
      case 'workspace':
        return deps.workspace(intent.action, intent.file);
      case 'navigate': {
        if (!cursor) return;
        const line = intent.action === 'detail' ? cursor.detail(intent.index) : cursor[intent.action]();
        return say(line);
      }
      case 'stop':
        return deps.flushSpeech();
      case 'guard':
        pendingAsk = false;
        if (deps.answerGuard(intent.choice)) say(GUARD_SAID[intent.choice]);
        return;
      case 'dictate':
        deps.dictation(true);
        return say('Pode ditar. Diga "manda" quando terminar.');
      case 'confirm':
        return confirm(intent.yes);
      case 'correct': {
        const heard = lastHeard ? closestPhrase(lastHeard, intent.meant) : null;
        if (!heard) return say('Não sei o que corrigir.');
        pendingConfirm = { kind: 'learn', heard, meant: intent.meant };
        return say(`Salvo que "${heard}" é ${intent.meant}?`);
      }
      case 'prompt': {
        const outcome = await deps.deliverPrompt(target.sessionId, intent.text);
        if (outcome === 'hold') {
          queuedPrompt = intent.text;
          return say('Ele ainda tá trabalhando; mando quando terminar.');
        }
        if (outcome !== 'sent') say('Não consegui mandar pro chat.');
        return;
      }
      case 'ask-manager': {
        if (deps.economy()) return say('No modo economia eu só entendo os comandos.');
        const reply = await deps.askManager(intent.text);
        const proposal = String(reply ?? '').match(PROPOSAL);
        if (proposal) pendingConfirm = { kind: 'intent', intent: { type: 'resume-task', number: Number(proposal[1]) } };
        return say(reply);
      }
      default:
        return undefined;
    }
  }

  return {
    target: () => ({ ...target }),

    async onUtterance(heard) {
      const corrected = deps.correct(heard).text;
      const intent = routeUtterance(corrected, {
        target: target.kind,
        pendingAsk,
        hasLastReply: Boolean(cursor),
        pendingConfirm: Boolean(pendingConfirm),
      });
      if (intent.type !== 'confirm' && intent.type !== 'correct') pendingConfirm = null;
      await act(intent, heard);
      if (intent.type !== 'correct' && intent.type !== 'confirm') lastHeard = heard;
    },

    // The bound chat finished a turn: its answer, spoken. True when handled,
    // so the usual alert for that chat stays quiet.
    async onSessionStop(session) {
      if (target.kind !== 'chat' || session.id !== target.sessionId) return false;
      const analysis = analyzeReply(session.lastMessage ?? '');
      const reply = await spokenReply(analysis, { summarize: deps.summarize, economy: deps.economy() });
      cursor = analysis.items ? createReplyCursor(analysis.items) : null;
      say(reply.speech, 3, { source: session.id });
      if (queuedPrompt) {
        const text = queuedPrompt;
        queuedPrompt = null;
        if ((await deps.deliverPrompt(session.id, text)) === 'hold') queuedPrompt = text;
      }
      return true;
    },

    onToolEvent(event) {
      if (target.kind !== 'chat' || event?.session_id !== target.sessionId) return;
      const line = narrator.narrate(event);
      if (line) say(line.text, 3, { replaceKey: `${target.sessionId}:${line.replaceKey}`, source: target.sessionId });
    },

    onGuardAsk({ speech }) {
      pendingAsk = true;
      say(speech, 2, { source: 'guard' });
    },

    onGuardAnswered() {
      pendingAsk = false;
    },

    onSessionEnded(sessionId) {
      if (target.kind !== 'chat' || target.sessionId !== sessionId) return;
      const label = boundTask ? `da ${boundTask}` : 'ligado';
      target = { kind: 'manager' };
      cursor = null;
      queuedPrompt = null;
      say(`O chat ${label} fechou; voltei pro gerente.`);
    },
  };
}
