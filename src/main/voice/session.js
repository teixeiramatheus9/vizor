import { routeUtterance } from './commands.js';
import { analyzeReply, createReplyCursor, needsSummary, spokenReply } from './replies.js';
import { createNarrator } from './narration.js';
import { closestPhrase } from './vocabulary.js';
import { findAgent, findMusicians } from '../maestro/orchestra.js';
import { parseSteps } from '../maestro/conductor.js';
import { REVIEW_TASK_PROMPT } from '../maestro/reviewer.js';

// The voice conversation (#161): who the voice talks to (the gerente or one
// chat), what each utterance does, and what comes back spoken. Every side
// effect is an injected dep, so the whole scene is tested with fakes.
const SAY_MAX = 160;
// The gerente's offers, in either language it speaks (it reads, the músicos
// act): resume a task's chat, pick up an issue, get a PR reviewed.
const PROPOSALS = [
  [/(?:quer que eu puxe a issue|want me to pick up issue) #?(\d+)/i, 'pick-issue'],
  [/(?:quer que eu peça revisão da pr|want me to get pr) #?(\d+)/i, 'review-pr'],
  [/(?:quer que eu retome a|want me to resume) (?:task |tarefa |issue )?#?(\d+)/i, 'resume-task'],
];
// What the new músico is told: plan first (the Maestro lights the plan up),
// and a reviewer reports without changing anything.
const PICK_PROMPT = (number) =>
  `Vamos trabalhar na issue #${number}. Leia com \`gh issue view ${number}\`, me diga o plano (quais arquivos e funções vai tocar) e espere meu ok antes de mexer. ` +
  'Termine o plano com uma linha `Vizor-plano: caminho/arquivo.js#funcao, outro/arquivo.js` (caminhos relativos à raiz do projeto).';
const REVIEW_PROMPT = (number) =>
  `Revise a PR #${number}: leia com \`gh pr view ${number}\` e \`gh pr diff ${number}\`, aponte os problemas por gravidade com arquivo e linha, e não mude código nem publique comentários sem eu pedir.`;
// What the voice says back follows the voice's language; the commands the
// user speaks stay Portuguese either way.
const LINES = {
  pt: {
    guard: { liberar: 'Liberado.', 'liberar-sessao': 'Liberado nesta sessão.', barrar: 'Barrado.' },
    ordinals: ['a primeira', 'a segunda', 'a terceira', 'a quarta', 'a quinta'],
    and: 'e',
    opened: (number, title, where) => `Abri a ${number}${title ? `, ${title}` : ''}.${where}`,
    candidates: (count, number, list) => `Achei ${count} conversas da ${number}: ${list}. Qual?`,
    noChat: (number) => `Não achei conversa da ${number}. Abro um chat novo pra ela?`,
    okay: 'Beleza.',
    newChatFailed: 'Não consegui abrir o chat novo.',
    newChat: (number) => `Abri um chat novo pra ${number}.`,
    saved: 'Salvo.',
    noOption: 'Não tem essa opção.',
    noSuchChat: 'Não achei esse chat.',
    talkingTo: (title) => `Falando com o chat ${title}.`,
    backToManager: 'Voltei pro gerente.',
    dictate: 'Pode ditar. Diga "manda" quando terminar.',
    nothingToCorrect: 'Não sei o que corrigir.',
    learnAsk: (heard, meant) => `Salvo que "${heard}" é ${meant}?`,
    hold: 'Ele ainda tá trabalhando; mando quando terminar.',
    sendFailed: 'Não consegui mandar pro chat.',
    economy: 'No modo economia eu só entendo os comandos.',
    done: 'Terminei.',
    chatClosed: (number) => `O chat ${number ? `da ${number}` : 'ligado'} fechou; voltei pro gerente.`,
    thinking: ['Tô dando uma olhada aqui.', 'Só um momento.', 'Conferindo.', 'Deixa eu ver.'],
    // The Maestro (#159).
    musicianOrdinals: ['o primeiro', 'o segundo', 'o terceiro', 'o quarto', 'o quinto'],
    // A músico is its task ("a 22") or its name ("o A1").
    noMusician: ({ number, agent }) => (agent ? `Não achei o A${agent}.` : `Não achei músico na ${number}.`),
    musicians: (count, number, list) => `Tem ${count} músicos na ${number}: ${list}. Qual?`,
    interrupted: (musician) => `Interrompi ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`}.`,
    interruptFailed: (musician) => `Não consegui interromper ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`}.`,
    focused: (musician) => `Foco ${musician.number !== null ? `na ${musician.number}` : `no ${musician.name}`}.`,
    maestroOn: 'Modo Maestro ativado.',
    maestroOff: 'Modo Maestro desativado.',
    picked: (number) => `Puxei a ${number}: o músico vai ler a issue e propor um plano.`,
    // The conducting gerente (#162).
    orderTaken: (musician) => `Combinado: quando ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`} terminar, eu mando.`,
    reviewerOn: (musician) => `Um avaliador vai revisar ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`}.`,
    suggestReviewer: (musician, touched, critical) =>
      `${musician.number !== null ? `A ${musician.number}` : `O ${musician.name}`} mexeu em ${touched} arquivos${
        critical ? `, ${critical} ${critical === 1 ? 'crítico' : 'críticos'}` : ''
      }. Chamo um avaliador?`,
    reviewing: (number) => `Um músico vai revisar a PR ${number}.`,
    cancelled: 'Cancelado.',
    alreadyRan: 'Já foi.',
    orderFailed: 'Deu erro nessa ordem; olha o log.',
    order: {
      interrupt: (musician) => (musician.number !== null ? `interromper a ${musician.number}` : `interromper o ${musician.name}`),
      prompt: (musician, text) =>
        !musician ? `mandar pro chat: ${text}` : musician.number !== null ? `mandar pra ${musician.number}: ${text}` : `mandar pro ${musician.name}: ${text}`,
      resume: (number) => `retomar a ${number}`,
      newChat: (number) => `abrir um chat novo pra ${number}`,
      pick: (number) => `puxar a issue ${number}`,
      whenDone: (musician, text) => `quando ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`} terminar: ${text}`,
      reviewer: (musician) => `chamar um avaliador pra ${musician.number !== null ? musician.number : musician.name}`,
      review: (number) => `revisar a PR ${number}`,
      guard: { liberar: 'liberar', 'liberar-sessao': 'liberar nesta sessão', barrar: 'barrar' },
    },
  },
  en: {
    guard: { liberar: 'Allowed.', 'liberar-sessao': 'Allowed for this session.', barrar: 'Blocked.' },
    ordinals: ['the first', 'the second', 'the third', 'the fourth', 'the fifth'],
    and: 'and',
    // The chat's last message is Portuguese: an English voice leaves it on screen.
    opened: (number, title) => `Opened ${number}${title ? `, ${title}` : ''}.`,
    candidates: (count, number, list) => `I found ${count} chats for ${number}: ${list}. Which one?`,
    noChat: (number) => `I didn't find a chat for ${number}. Should I open a new one?`,
    okay: 'Okay.',
    newChatFailed: "I couldn't open the new chat.",
    newChat: (number) => `Opened a new chat for ${number}.`,
    saved: 'Saved.',
    noOption: "There's no such option.",
    noSuchChat: "I didn't find that chat.",
    talkingTo: (title) => `Now talking to the chat ${title}.`,
    backToManager: 'Back to the manager.',
    dictate: 'Go ahead and dictate. Say "manda" when you\'re done.',
    nothingToCorrect: "I don't know what to correct.",
    learnAsk: (heard, meant) => `Save "${heard}" as ${meant}?`,
    hold: "It's still working; I'll send it when it's done.",
    sendFailed: "I couldn't send it to the chat.",
    economy: 'In economy mode I only understand commands.',
    done: 'Done.',
    chatClosed: (number) => `The ${number ? `chat for ${number}` : 'bound chat'} closed; back to the manager.`,
    thinking: ['Let me take a look.', 'One moment.', 'Checking.', 'Let me see.'],
    musicianOrdinals: ['the first', 'the second', 'the third', 'the fourth', 'the fifth'],
    noMusician: ({ number, agent }) => (agent ? `No A${agent}.` : `No músico on ${number}.`),
    musicians: (count, number, list) => `There are ${count} músicos on ${number}: ${list}. Which one?`,
    interrupted: (musician) => `Stopped ${musician.number ?? musician.name}.`,
    interruptFailed: (musician) => `I couldn't stop ${musician.number ?? musician.name}.`,
    focused: (musician) => `Focus on ${musician.number ?? musician.name}.`,
    maestroOn: 'Maestro mode on.',
    maestroOff: 'Maestro mode off.',
    picked: (number) => `Picked up ${number}: the músico will read the issue and propose a plan.`,
    orderTaken: (musician) => `Got it: when ${musician.number ?? musician.name} finishes, I'll send it.`,
    reviewerOn: (musician) => `A reviewer will look at ${musician.number ?? musician.name}.`,
    suggestReviewer: (musician, touched, critical) =>
      `${musician.number ?? musician.name} touched ${touched} files${critical ? `, ${critical} critical` : ''}. Should I call a reviewer?`,
    reviewing: (number) => `A músico will review PR ${number}.`,
    cancelled: 'Cancelled.',
    alreadyRan: 'It already went.',
    orderFailed: 'That order failed; check the log.',
  },
};

const firstSentence = (text) => {
  const sentence = (String(text ?? '').match(/^[^.!?\n]*[.!?]?/) ?? [''])[0].trim();
  return sentence.length > SAY_MAX ? `${sentence.slice(0, SAY_MAX).replace(/\s+\S*$/, '')}…` : sentence;
};
export function createVoiceSession(deps) {
  const lang = () => (LINES[deps.lang?.()] ? deps.lang() : 'pt');
  const lines = () => LINES[lang()];
  // One narrator per language: the voice can change mid-session.
  const narrators = {};
  const narrator = () => (narrators[lang()] ??= createNarrator({ lang: lang() }));
  // narration on/off; summary 'always' | 'short' (long ones stay on screen) | 'off'
  const settings = () => ({ narration: true, summary: 'always', ...(deps.settings?.() ?? {}) });
  let target = { kind: 'manager' };
  let boundTask = null; // the task number the bound chat was opened for
  let cursor = null;
  let pendingConfirm = null;
  let pendingAsk = false;
  let lastHeard = null;
  let lastHeardAt = -Infinity;
  let pendingChoice = null; // { kind, number, candidates } after "achei 2 conversas" or "tem 2 músicos"
  let queuedPrompt = null;
  const now = deps.now ?? Date.now;
  const CORRECTION_WINDOW_MS = 15000;
  const MAX_CANDIDATES = 5;

  // A voice reads emoji out loud ("rosto suando"): they never reach it.
  const speakable = (text) => String(text ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim();
  const say = (text, priority = 1, extra = {}) => {
    const clean = speakable(text);
    if (clean) deps.say({ text: clean, priority, ...extra });
  };

  // The AI takes seconds: a short line first, so the silence is not a doubt.
  // The answer queues behind it and plays once it ends; kind 'filler' keeps
  // the mic shut in between (it is not an answer to reply to).
  const thinking = (priority = 1, extra = {}) => {
    const options = lines().thinking;
    const index = Math.min(options.length - 1, Math.floor((deps.random?.() ?? Math.random()) * options.length));
    say(options[index], priority, { ...extra, kind: 'filler' });
  };

  function bind(sessionId, number = null) {
    target = { kind: 'chat', sessionId };
    boundTask = number;
    cursor = null;
    queuedPrompt = null;
  }

  async function openFound(number, found) {
    const opened = await deps.openOrFocus({ sessionId: found.sessionId, cwd: found.cwd });
    const sessionId = opened?.sessionId ?? found.sessionId;
    deps.linkTask(number, sessionId);
    bind(sessionId, number);
    const info = deps.sessionInfo(sessionId) ?? {};
    const where = info.lastMessage ? ` ${firstSentence(info.lastMessage)}` : '';
    say(lines().opened(number, info.title, where));
  }

  async function resumeTask(number) {
    const found = await deps.resolveTask(number);
    if (found.sessionId) {
      await openFound(number, found);
      return;
    }
    if (found.candidates) {
      const candidates = found.candidates.slice(0, MAX_CANDIDATES);
      pendingChoice = { kind: 'resume', number, candidates };
      deps.showLines(candidates.map((item, index) => `${index + 1}. ${item.title}`));
      const list = candidates.map((item, index) => `${lines().ordinals[index]}, ${item.title}`).join('; ');
      say(lines().candidates(candidates.length, number, list));
      return;
    }
    pendingConfirm = { kind: 'new-chat', number, cwd: found.cwd ?? deps.projectRoot() };
    say(lines().noChat(number));
  }

  // The Maestro: an order that changes work is shown as understood and held a
  // few seconds; off the Maestro it runs at once. The labels are on screen,
  // so they stay pt-BR whatever the voice speaks.
  const ORDER = LINES.pt.order;
  // Off the Maestro the order runs at once and its errors reach the caller,
  // as before; held, nobody awaits it, so a failure is logged and said.
  const held = (label, run) => {
    if (!deps.maestro?.() || !deps.pendingOrder) return run();
    deps.pendingOrder.hold({ label }, () =>
      Promise.resolve()
        .then(run)
        .catch((error) => {
          deps.onError?.(error);
          say(lines().orderFailed);
        }),
    );
    return undefined;
  };
  const musicianOfSession = (sessionId) => (deps.orchestra?.() ?? []).find((musician) => musician.sessionId === sessionId) ?? null;

  function interruptMusician(musician) {
    return held(ORDER.interrupt(musician), () =>
      say(deps.interrupt(musician.ptyId) ? lines().interrupted(musician) : lines().interruptFailed(musician)),
    );
  }

  function focusMusician(musician) {
    deps.focus(musician.sessionId);
    say(lines().focused(musician));
  }

  // "interrompa a task 22" / "vai pra 22": none says so, two asks which.
  // A task linked to chats is found only among them (one outside the Vizor is
  // no músico); a number nobody links is a place in the orchestra.
  // address: { number } (a task) or { agent } (A1, A2…).
  function onMusicians(kind, address, run) {
    const orchestra = deps.orchestra?.() ?? [];
    const { number, agent } = address;
    const linked = agent ? [] : deps.linkedSessions?.(number) ?? [];
    const found = agent
      ? findAgent(orchestra, agent)
      : linked.length
        ? orchestra.filter((musician) => linked.includes(musician.sessionId))
        : findMusicians(orchestra, number);
    if (!found.length) return say(lines().noMusician(address));
    if (found.length === 1) return run(found[0]);
    const candidates = found.slice(0, MAX_CANDIDATES);
    pendingChoice = { kind, number, candidates, text: address.text };
    const list = candidates.map((item, index) => `${lines().musicianOrdinals[index]}, ${item.label}`).join('; ');
    return say(lines().musicians(candidates.length, number, list));
  }

  async function confirm(yes) {
    const pending = pendingConfirm;
    pendingConfirm = null;
    if (!yes) {
      say(lines().okay);
      return;
    }
    if (pending.kind === 'new-chat') return held(ORDER.newChat(pending.number), () => openNewChat(pending));
    if (pending.kind === 'learn') {
      deps.learn({ heard: pending.heard, meant: pending.meant });
      say(lines().saved);
    } else if (pending.kind === 'intent') {
      await act(pending.intent, '');
    }
  }

  async function pickIssue(number) {
    const found = await deps.resolveTask(number);
    if (found.sessionId) return openFound(number, found);
    const opened = await deps.openNew({ cwd: found.cwd ?? deps.projectRoot(), prompt: PICK_PROMPT(number) });
    if (!opened?.sessionId) return say(lines().newChatFailed);
    deps.linkTask(number, opened.sessionId);
    bind(opened.sessionId, number);
    return say(lines().picked(number));
  }

  // The reviewer works on its own: the voice stays with whoever it was with.
  async function reviewPr(number) {
    const opened = await deps.openNew({ cwd: deps.projectRoot(), prompt: REVIEW_PROMPT(number) });
    if (!opened?.sessionId) return say(lines().newChatFailed);
    deps.linkTask(number, opened.sessionId);
    return say(lines().reviewing(number));
  }

  // "quando a 22 terminar, …": the conductor keeps it; a músico already
  // stopped gets it now.
  function orderFor(musician, text) {
    return held(ORDER.whenDone(musician, text), () => {
      deps.conductor?.order(musician.sessionId, { label: text, steps: parseSteps(text) });
      say(lines().orderTaken(musician));
      if (musician.status === 'done' || musician.status === 'waiting') deps.startOrderNow?.(musician.sessionId);
    });
  }

  // The reviewer works in the músico's own folder (its worktree).
  function reviewerFor(musician) {
    return held(ORDER.reviewer(musician), async () => {
      const opened = await deps.openNew({ cwd: musician.root ?? deps.projectRoot(), prompt: REVIEW_TASK_PROMPT(musician.number ?? musician.name) });
      if (!opened?.sessionId) return say(lines().newChatFailed);
      if (musician.number !== null && musician.number !== undefined) deps.linkTask(musician.number, opened.sessionId);
      return say(lines().reviewerOn(musician));
    });
  }

  async function openNewChat(pending) {
    const opened = await deps.openNew({ cwd: pending.cwd, prompt: `Vamos trabalhar na issue #${pending.number}.` });
    if (!opened?.sessionId) {
      say(lines().newChatFailed);
      return;
    }
    deps.linkTask(pending.number, opened.sessionId);
    bind(opened.sessionId, pending.number);
    say(lines().newChat(pending.number));
  }

  async function act(intent, raw) {
    switch (intent.type) {
      case 'status': {
        thinking();
        const digest = await deps.ghDigest();
        say(digest.speech);
        deps.showLines(digest.lines);
        return;
      }
      case 'resume-task':
        return held(ORDER.resume(intent.number), () => resumeTask(intent.number));
      case 'choose': {
        const choice = pendingChoice?.candidates[intent.index - 1];
        if (!choice) return say(lines().noOption);
        const { kind, number, text } = pendingChoice;
        pendingChoice = null;
        if (kind === 'interrupt') return interruptMusician(choice);
        if (kind === 'when-done') return orderFor(choice, text);
        if (kind === 'call-reviewer') return reviewerFor(choice);
        if (kind === 'focus') return focusMusician(choice);
        return openFound(number, choice);
      }
      case 'pick-issue':
        return held(ORDER.pick(intent.number), () => pickIssue(intent.number));
      case 'review-pr':
        return held(ORDER.review(intent.number), () => reviewPr(intent.number));
      case 'when-done':
        return onMusicians('when-done', intent, (musician) => orderFor(musician, intent.text));
      case 'call-reviewer':
        return onMusicians('call-reviewer', intent, reviewerFor);
      case 'interrupt':
        return onMusicians('interrupt', intent, interruptMusician);
      case 'focus':
        return onMusicians('focus', intent, focusMusician);
      case 'maestro':
        deps.setMaestro?.(intent.on);
        return say(intent.on ? lines().maestroOn : lines().maestroOff);
      case 'order':
        if (intent.action === 'now') return deps.pendingOrder?.runNow();
        deps.pendingOrder?.cancel();
        return say(lines().cancelled);
      case 'talk-to-chat': {
        const sessionId = deps.findChat(intent.query);
        if (!sessionId) return say(lines().noSuchChat);
        bind(sessionId);
        return say(lines().talkingTo(deps.sessionInfo(sessionId)?.title ?? intent.query));
      }
      case 'talk-to-manager':
        target = { kind: 'manager' };
        return say(lines().backToManager);
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
        return held(ORDER.guard[intent.choice], () => {
          if (deps.answerGuard(intent.choice)) say(lines().guard[intent.choice]);
        });
      case 'dictate':
        deps.dictation(true);
        return say(lines().dictate);
      case 'confirm':
        return confirm(intent.yes);
      case 'correct': {
        const heard = lastHeard ? closestPhrase(lastHeard, intent.meant) : null;
        if (!heard) return say(lines().nothingToCorrect);
        pendingConfirm = { kind: 'learn', heard, meant: intent.meant };
        return say(lines().learnAsk(heard, intent.meant));
      }
      case 'prompt': {
        const sessionId = target.sessionId;
        const text = intent.text;
        const preview = text.length > 80 ? `${text.slice(0, 80).replace(/\s+\S*$/, '')}…` : text;
        return held(ORDER.prompt(musicianOfSession(sessionId), preview), async () => {
          const outcome = await deps.deliverPrompt(sessionId, text);
          if (outcome === 'hold') {
            queuedPrompt = text;
            return say(lines().hold);
          }
          if (outcome !== 'sent') say(lines().sendFailed);
          return undefined;
        });
      }
      case 'ask-manager': {
        if (deps.economy()) return say(lines().economy);
        thinking();
        const reply = await deps.askManager(intent.text);
        for (const [pattern, type] of PROPOSALS) {
          const proposal = String(reply ?? '').match(pattern);
          if (!proposal) continue;
          pendingConfirm = { kind: 'intent', intent: { type, number: Number(proposal[1]) } };
          break;
        }
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
        pendingChoice: Boolean(pendingChoice),
        pendingOrder: Boolean(deps.pendingOrder?.pending()),
        canCorrect: Boolean(lastHeard) && now() - lastHeardAt < CORRECTION_WINDOW_MS,
      });
      // Only the wake word ("Vizor" … and a pause): nothing to do yet.
      if ((intent.type === 'prompt' || intent.type === 'ask-manager') && !intent.text.trim()) {
        deps.keepListening?.();
        return;
      }
      if (intent.type !== 'confirm' && intent.type !== 'correct') pendingConfirm = null;
      if (intent.type !== 'choose' && intent.type !== 'resume-task') pendingChoice = null;
      // "cancela"/"manda" just after the order went: too late, and not a prompt.
      const ORDER_WORDS_LATE_MS = 5000;
      if (
        (intent.type === 'prompt' || intent.type === 'ask-manager') &&
        now() - (deps.pendingOrder?.ranAt() ?? -Infinity) < ORDER_WORDS_LATE_MS &&
        routeUtterance(corrected, { pendingOrder: true }).type === 'order'
      ) {
        say(lines().alreadyRan);
        return;
      }
      // Anything said while an order waits replaces it: never both.
      if (intent.type !== 'order' && deps.pendingOrder?.pending()) deps.pendingOrder.cancel();
      await act(intent, heard);
      if (intent.type !== 'correct' && intent.type !== 'confirm') {
        lastHeard = heard;
        lastHeardAt = now();
      }
    },

    // The bound chat finished a turn: its answer, spoken. True when handled,
    // so the usual alert for that chat stays quiet.
    async onSessionStop(session) {
      if (target.kind !== 'chat' || session.id !== target.sessionId) return false;
      const analysis = analyzeReply(session.lastMessage ?? '');
      const { summary } = settings();
      if (summary === 'off') {
        cursor = null;
        say(lines().done, 3, { source: session.id });
      } else {
        const options = { economy: deps.economy() || summary === 'short', lang: lang() };
        if (needsSummary(analysis, options)) thinking(3, { source: session.id });
        const reply = await spokenReply(analysis, { summarize: deps.summarize, ...options });
        cursor = analysis.items ? createReplyCursor(analysis.items, lang()) : null;
        say(reply.speech, 3, { source: session.id });
      }
      if (queuedPrompt) {
        const text = queuedPrompt;
        queuedPrompt = null;
        if ((await deps.deliverPrompt(session.id, text)) === 'hold') queuedPrompt = text;
      }
      return true;
    },

    onToolEvent(event) {
      if (!settings().narration || target.kind !== 'chat' || event?.session_id !== target.sessionId) return;
      const line = narrator().narrate(event);
      if (line) say(line.text, 3, { replaceKey: `${target.sessionId}:${line.replaceKey}`, source: target.sessionId });
    },

    // The Vizor offers a reviewer (#162): "sim" calls it.
    onSuggestReviewer({ musician, touched, critical }) {
      pendingConfirm = { kind: 'intent', intent: { type: 'call-reviewer', number: musician.number, agent: musician.agent } };
      say(lines().suggestReviewer(musician, touched, critical), 2, { source: 'manager' });
    },

    // What the conductor reports (done, or it needs you); prompts go elsewhere.
    onConductorAction(action) {
      if (action.type !== 'prompt') say(action.text, 2, { source: 'manager' });
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
      const number = boundTask;
      target = { kind: 'manager' };
      cursor = null;
      queuedPrompt = null;
      say(lines().chatClosed(number));
    },
  };
}
