import { issueNumberIn, routeUtterance, soundsLikeWork } from './commands.js';
import { analyzeReply, createReplyCursor, needsSummary, spokenReply } from './replies.js';
import { createNarrator } from './narration.js';
import { closestPhrase } from './vocabulary.js';
import { findAgent, findMusicians } from '../maestro/orchestra.js';
import { parseSteps } from '../maestro/conductor.js';
import { REVIEW_TASK_PROMPT } from '../maestro/reviewer.js';
import { reviewPrPrompt, startIssuePrompt } from '../work/prompts.js';

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
    whichIssue: 'Qual issue? Diga, por exemplo: puxa a issue 162.',
    planSent: { approve: 'Mandei seguir com o plano.', pr: 'Pedi pra rodar os testes e abrir a PR.' },
    whichPlanChat: 'De qual chat? Diga o número da task.',
    planFailed: 'Não consegui falar com esse chat.',
    understood: (label) => `Entendi: ${label}.`,
    // Memory (#163).
    stoppedAt: (number, where) => `Na ${number}: ${where}`,
    noTask: (number) => `Não achei conversa da ${number}.`,
    noTrace: (number) => `A conversa da ${number} não tem resposta ainda.`,
    routineSaved: (name, count) => `Gravei a rotina ${name}: ${count} ${count === 1 ? 'passo' : 'passos'}.`,
    routines: (names) => (names.length ? `Rotinas: ${names.join(', ')}.` : 'Nenhuma rotina gravada.'),
    routineRunning: (name) => `Rodando a rotina ${name}.`,
    noRoutine: (name) => `Não tenho a rotina ${name}.`,
    routineForgotten: (name) => `Esqueci a rotina ${name}.`,
    noNesting: 'Uma rotina não roda outra.',
    routineStopped: (name) => `Parei a rotina ${name}.`,
    routineAsked: (name, step) => `Parei a rotina ${name} no passo ${step}: responda e siga à mão.`,
    routineHow: 'Pra gravar, diga: grava a rotina <nome>: passo, depois passo.',
    // The conducting gerente (#162).
    orderTaken: (musician) => `Combinado: quando ${musician.number !== null ? `a ${musician.number}` : `o ${musician.name}`} terminar, eu mando.`,
    orderReplaced: (musician) =>
      musician.number !== null
        ? `Troquei a ordem da ${musician.number}: quando ela terminar, eu mando a nova.`
        : `Troquei a ordem do ${musician.name}: quando ele terminar, eu mando a nova.`,
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
      routine: (name) => `rodar a rotina ${name}`,
      plan: (musician, action) => {
        const who = !musician ? 'do chat' : musician.number !== null ? `da ${musician.number}` : `do ${musician.name}`;
        return action === 'approve' ? `aprovar o plano ${who}` : `abrir a PR ${who}`;
      },
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
    whichIssue: 'Which issue? Say, for example: puxa a issue 162.',
    planSent: { approve: 'Told it to go ahead with the plan.', pr: 'Asked it to run the tests and open the PR.' },
    whichPlanChat: 'Which chat? Say the task number.',
    planFailed: "Couldn't reach that chat.",
    understood: (label) => `Got it: ${label}.`,
    stoppedAt: (number, where) => `On ${number}: ${where}`,
    noTask: (number) => `I didn't find a chat for ${number}.`,
    noTrace: (number) => `The chat for ${number} has no answer yet.`,
    routineSaved: (name, count) => `Saved the routine ${name}: ${count} ${count === 1 ? 'step' : 'steps'}.`,
    routines: (names) => (names.length ? `Routines: ${names.join(', ')}.` : 'No routine saved.'),
    routineRunning: (name) => `Running the routine ${name}.`,
    noRoutine: (name) => `I don't have the routine ${name}.`,
    routineForgotten: (name) => `Forgot the routine ${name}.`,
    noNesting: "A routine doesn't run another one.",
    routineStopped: (name) => `Stopped the routine ${name}.`,
    routineAsked: (name, step) => `Stopped the routine ${name} at step ${step}: answer it and go on by hand.`,
    routineHow: 'To save one, say: grava a rotina <nome>: passo, depois passo.',
    orderTaken: (musician) => `Got it: when ${musician.number ?? musician.name} finishes, I'll send it.`,
    orderReplaced: (musician) => `Replaced the order for ${musician.number ?? musician.name}: when it finishes, I'll send the new one.`,
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
  let queuedPrompts = []; // prompts for a busy chat, sent one per finished turn, in order
  const now = deps.now ?? Date.now;
  const CORRECTION_WINDOW_MS = 15000;
  const MAX_CANDIDATES = 5;
  let lastIssue = null; // the issue last talked about, by you or the gerente ("dê ela para um músico")
  const noteIssue = (text) => {
    const number = issueNumberIn(text) ?? Number(String(text ?? '').match(/#(\d+)/)?.[1] ?? NaN);
    if (Number.isInteger(number)) lastIssue = number;
  };

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
    queuedPrompts = [];
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

  // The Maestro: an order that cannot be undone (stopping a músico, typing
  // into it, answering a permission, a conditional order, a routine) is shown
  // as understood and held a few seconds; opening work (an issue, a chat, a
  // review) runs at once, since closing the tab undoes it. Off the Maestro
  // everything runs at once. The labels are on screen,
  // so they stay pt-BR whatever the voice speaks.
  const ORDER = LINES.pt.order;
  // Off the Maestro the order runs at once and its errors reach the caller,
  // as before; held, nobody awaits it, so a failure is logged and said.
  // A routine's own steps run straight (the routine was held once); a real
  // utterance meanwhile is held as usual and stops the routine (review).
  // directStep is only true while a step's act() runs its synchronous part,
  // which is where held() is called.
  let directStep = false;
  let routineRun = null; // { name, stopped }
  const held = (label, run) => {
    if (!deps.maestro?.() || !deps.pendingOrder || directStep) return run();
    // Said out loud too: a wrong number is heard at once, and "cancela" is right there.
    say(lines().understood(label), 1, { kind: 'filler' });
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

  // The plan card's buttons by voice: of the task named, else of the chat the
  // voice talks to, else of the músico in focus. It types into the chat: held.
  function planOrder(action, number) {
    const bound = target;
    const sessionId =
      number !== null
        ? deps.linkedSessions?.(number)?.[0] ?? findMusicians(deps.orchestra?.() ?? [], number)[0]?.sessionId
        : bound.kind === 'chat'
          ? bound.sessionId
          : deps.focusedSession?.();
    if (!sessionId) return say(lines().whichPlanChat);
    return held(ORDER.plan(musicianOfSession(sessionId), action), async () => {
      const result = await deps.planAction(sessionId, action);
      say(result === 'sent' ? lines().planSent[action] : lines().planFailed);
    });
  }

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
  // address: { number } (a task), { agent } (A1, A2…) or { sessionId } (an
  // offer the Vizor made: A-numbers move when tabs come and go).
  function onMusicians(kind, address, run) {
    const orchestra = deps.orchestra?.() ?? [];
    const { number, agent, sessionId } = address;
    const linked = agent || sessionId ? [] : deps.linkedSessions?.(number) ?? [];
    const found = sessionId
      ? orchestra.filter((musician) => musician.sessionId === sessionId)
      : agent
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
    if (pending.kind === 'new-chat') return openNewChat(pending);
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
    const opened = await deps.openNew({ cwd: found.cwd ?? deps.projectRoot(), prompt: startIssuePrompt(number), task: number });
    if (!opened?.sessionId) return say(lines().newChatFailed);
    deps.linkTask(number, opened.sessionId);
    bind(opened.sessionId, number);
    return say(lines().picked(number));
  }

  // The reviewer works on its own: the voice stays with whoever it was with.
  async function reviewPr(number) {
    const opened = await deps.openNew({ cwd: deps.projectRoot(), prompt: reviewPrPrompt(number) });
    if (!opened?.sessionId) return say(lines().newChatFailed);
    deps.linkTask(number, opened.sessionId);
    return say(lines().reviewing(number));
  }

  // "quando a 22 terminar, …": the conductor keeps it; a músico already
  // stopped gets it now.
  function orderFor(musician, text) {
    return held(ORDER.whenDone(musician, text), () => {
      const { replaced } = deps.conductor?.order(musician.sessionId, { label: text, steps: parseSteps(text) }) ?? {};
      say(replaced ? lines().orderReplaced(musician) : lines().orderTaken(musician));
      if (musician.status === 'done' || musician.status === 'waiting') deps.startOrderNow?.(musician.sessionId);
    });
  }

  // The reviewer works in the músico's own folder (its worktree).
  function reviewerFor(musician) {
    return held(ORDER.reviewer(musician), async () => {
      const opened = await deps.openNew({ cwd: musician.root ?? deps.projectRoot(), prompt: REVIEW_TASK_PROMPT(musician.number ?? musician.name) });
      // Not linked to the task: the reviewer is no other músico of it (review I6).
      if (!opened?.sessionId) return say(lines().newChatFailed);
      return say(lines().reviewerOn(musician));
    });
  }

  // "onde paramos na 22?": the task's chat, its last answer in short.
  async function whereStopped(number) {
    thinking();
    const found = await deps.resolveTask(number);
    const sessionId = found.sessionId ?? found.candidates?.[0]?.sessionId;
    if (!sessionId) return say(lines().noTask(number));
    const last = deps.sessionInfo(sessionId)?.lastMessage;
    if (!last) return say(lines().noTrace(number));
    const summary = deps.economy() ? null : await deps.summarize(last).catch(() => null);
    return say(lines().stoppedAt(number, summary || firstSentence(last)));
  }

  async function runRoutine(name) {
    if (routineRun) return say(lines().noNesting);
    const routine = deps.routines?.get(name);
    if (!routine) return say(lines().noRoutine(name));
    return held(ORDER.routine(routine.name), async () => {
      say(lines().routineRunning(routine.name));
      const run = { name: routine.name, stopped: false };
      routineRun = run;
      try {
        for (const [index, step] of routine.steps.entries()) {
          if (run.stopped) return say(lines().routineStopped(routine.name));
          await handleUtterance(step, { direct: true });
          // A step that asked something waits for you: the routine stops there.
          if (pendingConfirm || pendingChoice) return say(lines().routineAsked(routine.name, index + 1));
        }
        if (run.stopped) say(lines().routineStopped(routine.name));
      } finally {
        if (routineRun === run) routineRun = null;
      }
    });
  }

  async function openNewChat(pending) {
    const opened = await deps.openNew({ cwd: pending.cwd, prompt: startIssuePrompt(pending.number), task: pending.number });
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
        return resumeTask(intent.number);
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
      case 'pick-issue': {
        const number = intent.number ?? lastIssue;
        if (number === null) return say(lines().whichIssue);
        return pickIssue(number);
      }
      case 'approve-plan':
      case 'open-pr':
        return planOrder(intent.type === 'approve-plan' ? 'approve' : 'pr', intent.number);
      case 'review-pr':
        return reviewPr(intent.number);
      case 'where-stopped':
        return whereStopped(intent.number);
      case 'save-routine':
        deps.routines?.save(intent.name, intent.steps);
        return say(lines().routineSaved(intent.name, intent.steps.length));
      case 'save-routine-invalid':
        return say(lines().routineHow);
      case 'run-routine':
        return runRoutine(intent.name);
      case 'list-routines':
        return say(lines().routines((deps.routines?.list() ?? []).map((routine) => routine.name)));
      case 'forget-routine':
        return say(deps.routines?.remove(intent.name) ? lines().routineForgotten(intent.name) : lines().noRoutine(intent.name));
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
            queuedPrompts.push(text);
            return say(lines().hold);
          }
          if (outcome !== 'sent') say(lines().sendFailed);
          return undefined;
        });
      }
      case 'ask-manager': {
        if (deps.economy()) return say(lines().economy);
        thinking();
        // A garbled order ("pega eixo e um meia 9"): the interpreter, with the
        // open issues in hand, may still tell what was meant (live test).
        if (deps.interpret && soundsLikeWork(intent.text)) {
          const meant = await deps.interpret(intent.text).catch(() => null);
          if (meant?.type === 'pick-issue' && Number.isInteger(meant.number)) return act(meant, raw);
        }
        const reply = await deps.askManager(intent.text);
        noteIssue(reply);
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

  // One utterance, spoken or a routine's step (direct: no hold of its own).
  async function handleUtterance(heard, { direct = false } = {}) {
    const corrected = deps.correct(heard).text;
    noteIssue(corrected);
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
    directStep = direct;
    const acting = act(intent, heard);
    directStep = false;
    await acting;
    // A routine's step is not what you said: "não, é X" corrects your own words.
    if (!direct && intent.type !== 'correct' && intent.type !== 'confirm') {
      lastHeard = heard;
      lastHeardAt = now();
    }
  }

  const api = {
    target: () => ({ ...target }),

    // A real utterance: if a routine is running, it stops after its current step.
    async onUtterance(heard) {
      if (routineRun) routineRun.stopped = true;
      return handleUtterance(heard, { direct: false });
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
      if (queuedPrompts.length) {
        const text = queuedPrompts.shift();
        if ((await deps.deliverPrompt(session.id, text)) === 'hold') queuedPrompts.unshift(text);
      }
      return true;
    },

    onToolEvent(event) {
      if (!settings().narration || target.kind !== 'chat' || event?.session_id !== target.sessionId) return;
      const line = narrator().narrate(event);
      if (line) say(line.text, 3, { replaceKey: `${target.sessionId}:${line.replaceKey}`, source: target.sessionId });
    },

    // The Vizor offers a reviewer (#162): "sim" calls it.
    // Never over another open question, nor for the chat the voice is with
    // (its own "sim" belongs to it). True when it was offered (review I5).
    onSuggestReviewer({ musician, touched, critical }) {
      if (pendingConfirm || pendingChoice || pendingAsk) return false;
      if (target.kind === 'chat' && target.sessionId === musician.sessionId) return false;
      pendingConfirm = { kind: 'intent', intent: { type: 'call-reviewer', sessionId: musician.sessionId } };
      say(lines().suggestReviewer(musician, touched, critical), 2, { source: 'manager' });
      return true;
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
      queuedPrompts = [];
      say(lines().chatClosed(number));
    },
  };
  return api;
}
