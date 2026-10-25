import { describe, it, expect } from 'vitest';
import { createVoiceSession } from '../src/main/voice/session.js';

function setup(overrides = {}) {
  const said = [];
  const calls = [];
  const deps = {
    say: (item) => said.push(item),
    flushSpeech: () => calls.push(['flush']),
    correct: (text) => ({ text }),
    ghDigest: async () => ({ speech: '3 PRs abertas. O CI da 158 quebrou.', lines: ['#158 x'] }),
    showLines: (lines) => calls.push(['show', lines]),
    resolveTask: async () => ({ sessionId: 's22', cwd: '/r' }),
    openOrFocus: async (target) => (calls.push(['open', target]), { sessionId: target.sessionId }),
    openNew: async (request) => (calls.push(['new', request]), { sessionId: 'snew' }),
    linkTask: (number, sessionId) => calls.push(['link', number, sessionId]),
    sessionInfo: () => ({ title: 'Login com senha', lastMessage: 'Paramos na criptografia de senha. Faltava escolher o algoritmo.', cwd: '/r' }),
    deliverPrompt: async (sessionId, text) => (calls.push(['deliver', sessionId, text]), 'sent'),
    askManager: async () => 'Tem 2 chats rodando.',
    answerGuard: (choice) => (calls.push(['guard', choice]), true),
    workspace: (action, file) => calls.push(['workspace', action, file ?? null]),
    summarize: async () => 'Resumo curto.',
    economy: () => false,
    learn: (pair) => calls.push(['learn', pair]),
    findChat: (query) => (query === 'pty-host' ? 'spty' : null),
    dictation: (on) => calls.push(['dictation', on]),
    projectRoot: () => '/r',
    ...overrides,
  };
  const session = createVoiceSession(deps);
  const texts = () => said.map((item) => item.text);
  return { session, said, calls, texts };
}

describe('voice session — the scene', () => {
  it('status → resume 22 → a prompt → the spoken summary', async () => {
    const { session, said, calls, texts } = setup();
    await session.onUtterance('o que temos pra hoje?');
    expect(texts().at(-1)).toBe('3 PRs abertas. O CI da 158 quebrou.');
    expect(calls).toContainEqual(['show', ['#158 x']]);

    await session.onUtterance('retoma a task vinte e dois');
    expect(calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);
    expect(calls).toContainEqual(['link', 22, 's22']);
    expect(session.target()).toEqual({ kind: 'chat', sessionId: 's22' });
    expect(texts().at(-1)).toBe('Abri a 22, Login com senha. Paramos na criptografia de senha.');

    await session.onUtterance('me dá as opções de hash de senha e recomenda uma');
    expect(calls).toContainEqual(['deliver', 's22', 'me dá as opções de hash de senha e recomenda uma']);

    const handled = await session.onSessionStop({ id: 's22', lastMessage: '- **argon2id**: moderno.\n- **bcrypt**: maduro.\n\nRecomendo argon2id.' });
    expect(handled).toBe(true);
    expect(said.at(-1)).toMatchObject({ text: 'duas opções: argon2id e bcrypt. Recomendo argon2id. Quer que eu leia os tópicos?', priority: 3 });

    await session.onUtterance('lê os tópicos');
    expect(texts().at(-1)).toBe('Primeiro: argon2id: moderno.');
  });

  it("another chat's Stop is not handled (the normal alert stays)", async () => {
    const { session } = setup();
    await session.onUtterance('retoma a task 22');
    expect(await session.onSessionStop({ id: 'outra', lastMessage: 'x' })).toBe(false);
  });
});

describe('voice session — edges', () => {
  it('a busy chat keeps the prompt and sends it when the turn ends', async () => {
    let outcome = 'hold';
    const { session, calls, texts } = setup({ deliverPrompt: async (sessionId, text) => (calls.push(['deliver', sessionId, text]), outcome) });
    await session.onUtterance('retoma a task 22');
    await session.onUtterance('agora roda os testes');
    expect(texts().at(-1)).toBe('Ele ainda tá trabalhando; mando quando terminar.');
    outcome = 'sent';
    await session.onSessionStop({ id: 's22', lastMessage: 'Feito.' });
    expect(calls.filter(([name]) => name === 'deliver').map(([, , text]) => text)).toEqual(['agora roda os testes', 'agora roda os testes']);
  });

  it('two candidate chats are listed, not guessed, and "a segunda" opens the second (I8)', async () => {
    const { session, calls, texts } = setup({
      resolveTask: async () => ({ candidates: [{ sessionId: 'a', title: 'Login', cwd: '/r' }, { sessionId: 'b', title: 'Senha', cwd: '/r' }] }),
    });
    await session.onUtterance('retoma a task 22');
    expect(texts().at(-1)).toBe('Achei 2 conversas da 22: a primeira, Login; a segunda, Senha. Qual?');
    expect(calls.some(([name]) => name === 'open')).toBe(false);
    expect(calls).toContainEqual(['show', ['1. Login', '2. Senha']]);
    await session.onUtterance('a segunda');
    expect(calls).toContainEqual(['open', { sessionId: 'b', cwd: '/r' }]);
    expect(calls).toContainEqual(['link', 22, 'b']);
    expect(session.target()).toEqual({ kind: 'chat', sessionId: 'b' });
  });

  it('I9: a new chat that failed to open does not take the voice', async () => {
    const { session, texts } = setup({ resolveTask: async () => ({ none: true, cwd: '/r' }), openNew: async () => ({ sessionId: null }) });
    await session.onUtterance('retoma a task 22');
    await session.onUtterance('sim');
    expect(session.target()).toEqual({ kind: 'manager' });
    expect(texts().at(-1)).toBe('Não consegui abrir o chat novo.');
  });

  it('no chat for the task: offers a new one, opened on "sim"', async () => {
    const { session, calls, texts } = setup({ resolveTask: async () => ({ none: true, cwd: '/r-wt/login' }) });
    await session.onUtterance('retoma a task 22');
    expect(texts().at(-1)).toBe('Não achei conversa da 22. Abro um chat novo pra ela?');
    await session.onUtterance('sim');
    expect(calls).toContainEqual(['new', { cwd: '/r-wt/login', prompt: 'Vamos trabalhar na issue #22.' }]);
    expect(calls).toContainEqual(['link', 22, 'snew']);
    expect(session.target()).toEqual({ kind: 'chat', sessionId: 'snew' });
  });

  it('a gerente proposal runs only after "sim"', async () => {
    const { session, calls } = setup({ askManager: async () => 'A 22 parou ontem. Quer que eu retome a 22?' });
    await session.onUtterance('o que ficou parado?');
    expect(calls.some(([name]) => name === 'open')).toBe(false);
    await session.onUtterance('sim');
    expect(calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);
  });

  it('the bound chat ending sends the voice back to the gerente', async () => {
    const { session, texts } = setup();
    await session.onUtterance('retoma a task 22');
    session.onSessionEnded('s22');
    expect(session.target()).toEqual({ kind: 'manager' });
    expect(texts().at(-1)).toBe('O chat da 22 fechou; voltei pro gerente.');
  });

  it('economy mode never calls the gerente or the summarizer', async () => {
    const never = async () => {
      throw new Error('no tokens in economy');
    };
    const { session, texts } = setup({ economy: () => true, askManager: never, summarize: never });
    await session.onUtterance('qual a melhor forma de fazer isso?');
    expect(texts().at(-1)).toBe('No modo economia eu só entendo os comandos.');
    await session.onUtterance('retoma a task 22');
    await session.onSessionStop({ id: 's22', lastMessage: 'texto longo. '.repeat(40) });
    expect(texts().at(-1)).toBe('Terminei, a resposta tá na tela.');
  });

  it('narration off: tool events say nothing', async () => {
    const { session, said } = setup({ settings: () => ({ narration: false, summary: 'always' }) });
    await session.onUtterance('retoma a task 22');
    const before = said.length;
    session.onToolEvent({ session_id: 's22', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.js' } });
    expect(said).toHaveLength(before);
  });

  it('summary "short": long answers stay on screen; "off": only that it finished', async () => {
    const long = 'texto longo. '.repeat(40);
    const short = setup({ settings: () => ({ narration: true, summary: 'short' }), summarize: async () => 'resumo' });
    await short.session.onUtterance('retoma a task 22');
    await short.session.onSessionStop({ id: 's22', lastMessage: long });
    expect(short.texts().at(-1)).toBe('Terminei, a resposta tá na tela.');
    const off = setup({ settings: () => ({ narration: true, summary: 'off' }) });
    await off.session.onUtterance('retoma a task 22');
    await off.session.onSessionStop({ id: 's22', lastMessage: 'Feito, troquei.' });
    expect(off.texts().at(-1)).toBe('Terminei.');
  });

  it('just the wake word sends nothing and keeps listening (live test: "Pfizer")', async () => {
    let kept = 0;
    const { session, said, calls } = setup({ keepListening: () => kept++ });
    await session.onUtterance('Pfizer.');
    await session.onUtterance('Vizor');
    expect(said).toEqual([]);
    expect(calls.filter(([name]) => name === 'deliver')).toEqual([]);
    expect(kept).toBe(2);
  });

  it('never speaks emoji', async () => {
    const { session, texts } = setup({ askManager: async () => 'Xii, travei aqui 😅 tenta de novo?' });
    await session.onUtterance('como tá a vida?');
    expect(texts().at(-1)).toBe('Xii, travei aqui tenta de novo?');
  });

  it('the trava, spoken and answered by voice', async () => {
    const { session, said, calls } = setup();
    session.onGuardAsk({ speech: 'um Claude quer dar push na main, posso seguir?' });
    expect(said.at(-1)).toMatchObject({ priority: 2 });
    await session.onUtterance('barra');
    expect(calls).toContainEqual(['guard', 'barrar']);
  });

  it('narration only for the bound chat', async () => {
    const { session, said } = setup();
    session.onToolEvent({ session_id: 's22', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.js' } });
    expect(said).toHaveLength(0);
    await session.onUtterance('retoma a task 22');
    session.onToolEvent({ session_id: 's22', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.js' } });
    expect(said.at(-1)).toMatchObject({ text: 'mexendo no a.js', priority: 3, replaceKey: 's22:edit' });
  });

  it('learns a correction after a yes', async () => {
    const { session, calls, texts } = setup();
    await session.onUtterance('roda os testes do rubik guard');
    await session.onUtterance('não, é rule-guard');
    expect(texts().at(-1)).toBe('Salvo que "rubik guard" é rule-guard?');
    await session.onUtterance('sim');
    expect(calls).toContainEqual(['learn', { heard: 'rubik guard', meant: 'rule-guard' }]);
  });

  it('stop, dictation and workspace commands', async () => {
    const { session, calls } = setup();
    await session.onUtterance('para');
    await session.onUtterance('vou ditar');
    await session.onUtterance('esconde o chat');
    expect(calls).toEqual(expect.arrayContaining([['flush'], ['dictation', true], ['workspace', 'hide-chat', null]]));
  });
});

describe('voice session — an English voice (hear English, speak Portuguese)', () => {
  const english = (overrides = {}) => setup({ lang: () => 'en', summarize: async () => 'Short summary.', ...overrides });

  it('the commands stay Portuguese; what comes back is English', async () => {
    const { session, texts, calls } = english();
    await session.onUtterance('retoma a task 22');
    expect(texts().at(-1)).toBe('Opened 22, Login com senha.');
    await session.onSessionStop({ id: 's22', lastMessage: 'Feito.' });
    expect(texts().at(-1)).toBe('Short summary.');
    await session.onUtterance('volta pro gerente');
    expect(texts().at(-1)).toBe('Back to the manager.');
    await session.onUtterance('vou ditar');
    expect(texts().at(-1)).toBe('Go ahead and dictate. Say "manda" when you\'re done.');
    expect(calls).toContainEqual(['dictation', true]);
  });

  it('candidates, a new chat, and a busy chat', async () => {
    const two = english({ resolveTask: async () => ({ candidates: [{ sessionId: 'a', title: 'Login', cwd: '/r' }, { sessionId: 'b', title: 'Senha', cwd: '/r' }] }) });
    await two.session.onUtterance('retoma a task 22');
    expect(two.texts().at(-1)).toBe('I found 2 chats for 22: the first, Login; the second, Senha. Which one?');

    const none = english({ resolveTask: async () => ({ none: true, cwd: '/r' }) });
    await none.session.onUtterance('retoma a task 22');
    expect(none.texts().at(-1)).toBe("I didn't find a chat for 22. Should I open a new one?");
    await none.session.onUtterance('sim');
    expect(none.texts().at(-1)).toBe('Opened a new chat for 22.');

    const busy = english({ deliverPrompt: async () => 'hold' });
    await busy.session.onUtterance('retoma a task 22');
    await busy.session.onUtterance('agora roda os testes');
    expect(busy.texts().at(-1)).toBe("It's still working; I'll send it when it's done.");
    busy.session.onSessionEnded('s22');
    expect(busy.texts().at(-1)).toBe('The chat for 22 closed; back to the manager.');
  });

  it('economy mode, the trava, a gerente proposal in English, and narration', async () => {
    const economy = english({ economy: () => true });
    await economy.session.onUtterance('qual a melhor forma de fazer isso?');
    expect(economy.texts().at(-1)).toBe('In economy mode I only understand commands.');

    const guard = english();
    guard.session.onGuardAsk({ speech: 'A Claude wants to run rm. Can I go ahead?' });
    await guard.session.onUtterance('libera');
    expect(guard.texts().at(-1)).toBe('Allowed.');

    const proposal = english({ askManager: async () => '22 stalled yesterday. Want me to resume task 22?' });
    await proposal.session.onUtterance('o que ficou parado?');
    await proposal.session.onUtterance('sim');
    expect(proposal.calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);

    const narrated = english();
    await narrated.session.onUtterance('retoma a task 22');
    narrated.session.onToolEvent({ session_id: 's22', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(narrated.texts().at(-1)).toBe('running the tests');
  });
});

describe('voice session — a short line while the AI thinks (live test: the answers took long)', () => {
  it('the gerente: a filler first, then the answer, both direct replies', async () => {
    const { session, said } = setup({ random: () => 0 });
    await session.onUtterance('o que ficou parado ontem?');
    expect(said.map((item) => [item.text, item.kind ?? null])).toEqual([
      ['Tô dando uma olhada aqui.', 'filler'],
      ['Tem 2 chats rodando.', null],
    ]);
    expect(said[0].priority).toBe(1);
  });

  it('the GitHub status and a summarized answer get one too; a short answer read as is does not', async () => {
    const { session, said } = setup({ random: () => 0.99 });
    await session.onUtterance('o que temos pra hoje?');
    expect(said.slice(-2).map((item) => item.text)).toEqual(['Deixa eu ver.', '3 PRs abertas. O CI da 158 quebrou.']);
    await session.onUtterance('retoma a task 22');
    said.length = 0;
    await session.onSessionStop({ id: 's22', lastMessage: 'texto longo. '.repeat(40) });
    expect(said.map((item) => item.kind ?? null)).toEqual(['filler', null]);
    said.length = 0;
    await session.onSessionStop({ id: 's22', lastMessage: 'Feito.' });
    expect(said.map((item) => item.text)).toEqual(['Feito.']);
  });

  it('in English, and never in economy mode (nothing to wait for)', async () => {
    const english = setup({ lang: () => 'en', random: () => 0 });
    await english.session.onUtterance('o que ficou parado?');
    expect(english.said[0].text).toBe('Let me take a look.');
    const economy = setup({ economy: () => true });
    await economy.session.onUtterance('o que ficou parado?');
    expect(economy.said.map((item) => item.kind ?? null)).toEqual([null]);
  });
});

describe('voice session — Maestro', async () => {
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const musician = (sessionId, number, ptyId = `p-${sessionId}`) => ({ sessionId, number, ptyId, label: `chat ${sessionId}`, status: 'working', color: '#fff', files: [] });

  // A real pending order on a fake timer: fire() lets the 3 s run out.
  function maestro(overrides = {}) {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const interrupted = [];
    const focused = [];
    const modes = [];
    const scene = setup({
      maestro: () => true,
      setMaestro: (on) => modes.push(on),
      orchestra: () => [musician('s22', 22), musician('s2', 2)],
      interrupt: (ptyId) => (interrupted.push(ptyId), true),
      focus: (sessionId) => focused.push(sessionId),
      pendingOrder,
      ...overrides,
    });
    return { ...scene, pendingOrder, interrupted, focused, modes, fire: () => timer?.() };
  }

  it('interrompa a task 22: held, then Esc to that músico only', async () => {
    const { session, interrupted, pendingOrder, fire, texts } = maestro();
    await session.onUtterance('Vizor, interrompa a task 22');
    expect(interrupted).toEqual([]);
    expect(pendingOrder.pending().label).toBe('interromper a 22');
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupted).toEqual(['p-s22']);
    expect(texts().at(-1)).toBe('Interrompi a 22.');
  });

  it('in English the voice says it in English', async () => {
    const { session, fire, texts } = maestro({ lang: () => 'en' });
    await session.onUtterance('interrompa a task 22');
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(texts().at(-1)).toBe('Stopped 22.');
  });

  it('interrupt a task with no músico, or one outside the Vizor: says so, writes nothing', async () => {
    const { session, interrupted, pendingOrder, texts } = maestro();
    await session.onUtterance('interrompa a task 40');
    expect(texts().at(-1)).toBe('Não achei músico na 40.');
    expect(pendingOrder.pending()).toBeNull();
    expect(interrupted).toEqual([]);
    const english = maestro({ lang: () => 'en' });
    await english.session.onUtterance('interrompa a task 40');
    expect(english.texts().at(-1)).toBe('No músico on 40.');
  });

  it('two músicos on one number: asks which', async () => {
    const { session, interrupted, fire, texts } = maestro({ orchestra: () => [musician('a', 22), musician('b', 22)] });
    await session.onUtterance('interrompa a task 22');
    expect(texts().at(-1)).toBe('Tem 2 músicos na 22: o primeiro, chat a; o segundo, chat b. Qual?');
    await session.onUtterance('o segundo');
    fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupted).toEqual(['p-b']);
  });

  it('focus is immediate, never held', async () => {
    const { session, focused, pendingOrder } = maestro();
    await session.onUtterance('vai pra 2');
    expect(focused).toEqual(['s2']);
    expect(pendingOrder.pending()).toBeNull();
  });

  it('a prompt to the bound músico is held while the Maestro is on, sent at once when it is off', async () => {
    const on = maestro();
    await on.session.onUtterance('retoma a task 22');
    on.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await on.session.onUtterance('roda os testes de novo');
    expect(on.calls.filter(([name]) => name === 'deliver')).toEqual([]);
    expect(on.pendingOrder.pending().label).toBe('mandar pra 22: roda os testes de novo');
    on.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(on.calls).toContainEqual(['deliver', 's22', 'roda os testes de novo']);

    const off = maestro({ maestro: () => false });
    await off.session.onUtterance('retoma a task 22');
    await off.session.onUtterance('roda os testes de novo');
    expect(off.calls).toContainEqual(['deliver', 's22', 'roda os testes de novo']);
  });

  it('cancela drops the held order; manda runs it now', async () => {
    const { session, interrupted, pendingOrder } = maestro();
    await session.onUtterance('interrompa a task 22');
    await session.onUtterance('cancela');
    expect(pendingOrder.pending()).toBeNull();
    expect(interrupted).toEqual([]);
    await session.onUtterance('interrompa a task 22');
    await session.onUtterance('manda');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(interrupted).toEqual(['p-s22']);
  });

  it('another utterance during the window cancels the held order first', async () => {
    const { session, interrupted, pendingOrder, focused, fire } = maestro();
    await session.onUtterance('interrompa a task 22');
    await session.onUtterance('vai pra 2');
    expect(pendingOrder.pending()).toBeNull();
    fire();
    expect(interrupted).toEqual([]);
    expect(focused).toEqual(['s2']);
  });

  it('ative o modo Maestro / desative o modo Maestro', async () => {
    const { session, modes, texts } = maestro({ maestro: () => false });
    await session.onUtterance('Vizor, ative o modo Maestro');
    expect(modes).toEqual([true]);
    expect(texts().at(-1)).toBe('Modo Maestro ativado.');
    await session.onUtterance('desative o modo maestro');
    expect(modes).toEqual([true, false]);
    expect(texts().at(-1)).toBe('Modo Maestro desativado.');
    const english = maestro({ lang: () => 'en' });
    await english.session.onUtterance('ative o modo maestro');
    expect(english.texts().at(-1)).toBe('Maestro mode on.');
  });
});

describe('voice session — Maestro, review fixes', async () => {
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const musician = (sessionId, number) => ({ sessionId, number, ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status: 'working', color: '#fff', files: [] });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  function maestro(overrides = {}) {
    let timer = null;
    let time = 1000;
    const pendingOrder = createPendingOrder({ now: () => time, setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const interrupted = [];
    const errors = [];
    const scene = setup({
      now: () => time,
      maestro: () => true,
      orchestra: () => [musician('s1', 1), musician('s2', 2)],
      interrupt: (ptyId) => (interrupted.push(ptyId), true),
      focus: () => {},
      pendingOrder,
      onError: (error) => errors.push(error.message),
      ...overrides,
    });
    return { ...scene, pendingOrder, interrupted, errors, fire: () => timer?.(), advance: (ms) => (time += ms) };
  }

  it('C1: "cancela" right after the order ran says it already went, and sends nothing', async () => {
    const { session, fire, advance, calls, texts, pendingOrder } = maestro();
    await session.onUtterance('retoma a task 22');
    fire();
    await tick();
    await session.onUtterance('interrompa a task 2');
    fire();
    await tick();
    advance(2000);
    await session.onUtterance('cancela');
    expect(texts().at(-1)).toBe('Já foi.');
    expect(calls.filter(([name]) => name === 'deliver')).toEqual([]);
    advance(10000);
    await session.onUtterance('cancela');
    // Long after: just words for the chat, held like any prompt.
    expect(pendingOrder.pending().label).toBe('mandar pro chat: cancela');
  });

  it('I1: a task number linked to a chat outside the Vizor never falls back to the músico in that place', async () => {
    const { session, interrupted, texts } = maestro({ linkedSessions: (number) => (number === 2 ? ['outside'] : []) });
    await session.onUtterance('interrompa a task 2');
    expect(texts().at(-1)).toBe('Não achei músico na 2.');
    expect(interrupted).toEqual([]);
  });

  it('I1: a task number linked to a músico finds it even when its place is another', async () => {
    const { session, fire, interrupted } = maestro({ linkedSessions: (number) => (number === 2 ? ['s1'] : []) });
    await session.onUtterance('interrompa a task 2');
    fire();
    await tick();
    expect(interrupted).toEqual(['p-s1']);
  });

  it('I3: with the Maestro off an error reaches the caller again; on, it is reported and said', async () => {
    const failing = async () => {
      throw new Error('pty gone');
    };
    const off = maestro({ maestro: () => false, deliverPrompt: failing });
    await off.session.onUtterance('retoma a task 22');
    await expect(off.session.onUtterance('roda os testes')).rejects.toThrow('pty gone');

    const on = maestro({ deliverPrompt: failing });
    await on.session.onUtterance('retoma a task 22');
    on.fire();
    await tick();
    await on.session.onUtterance('roda os testes');
    on.fire();
    await tick();
    expect(on.errors).toEqual(['pty gone']);
    expect(on.texts().at(-1)).toBe('Deu erro nessa ordem; olha o log.');
  });
});

describe('voice session — the gerente reads, the músicos act', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('"sim" to "Quer que eu puxe a issue 142?" opens a músico that plans before touching code', async () => {
    const { session, calls, texts } = setup({
      askManager: async () => 'A 142 tá sem dono. Quer que eu puxe a issue 142?',
      resolveTask: async () => ({ none: true, cwd: '/r' }),
    });
    await session.onUtterance('puxa uma das issues que a gente tem');
    await session.onUtterance('sim');
    await tick();
    const opened = calls.find(([name]) => name === 'new');
    expect(opened[1].cwd).toBe('/r');
    expect(opened[1].prompt).toContain('issue #142');
    expect(opened[1].prompt).toContain('gh issue view 142');
    expect(opened[1].prompt).toContain('espere meu ok antes de mexer');
    expect(calls).toContainEqual(['link', 142, 'snew']);
    expect(texts().at(-1)).toBe('Puxei a 142: o músico vai ler a issue e propor um plano.');
  });

  it('picking an issue that already has a chat opens that chat instead', async () => {
    const { session, calls } = setup();
    await session.onUtterance('puxa a issue 22');
    await tick();
    expect(calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);
    expect(calls.some(([name]) => name === 'new')).toBe(false);
  });

  it('"Quer que eu peça revisão da PR 166?" → a reviewer músico that reports and changes nothing', async () => {
    const { session, calls, texts } = setup({ askManager: async () => 'A 166 tá parada. Quer que eu peça revisão da PR 166?' });
    await session.onUtterance('o que ficou parado?');
    await session.onUtterance('sim');
    await tick();
    const opened = calls.find(([name]) => name === 'new');
    expect(opened[1].prompt).toContain('PR #166');
    expect(opened[1].prompt).toContain('gh pr diff 166');
    expect(opened[1].prompt).toContain('não mude código nem publique comentários sem eu pedir');
    expect(calls).toContainEqual(['link', 166, 'snew']);
    expect(texts().at(-1)).toBe('Um músico vai revisar a PR 166.');
    expect(session.target()).toEqual({ kind: 'manager' });
  });

  it('English proposals work the same, and the order is held in the Maestro', async () => {
    const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const { session, calls } = setup({
      lang: () => 'en',
      maestro: () => true,
      orchestra: () => [],
      pendingOrder,
      askManager: async () => 'Want me to get PR 166 reviewed?',
    });
    await session.onUtterance('alguma PR parada?');
    await session.onUtterance('sim');
    expect(pendingOrder.pending().label).toBe('revisar a PR 166');
    timer();
    await tick();
    expect(calls.find(([name]) => name === 'new')[1].prompt).toContain('PR #166');
  });
});

describe('voice session — músicos named A1, A2…', async () => {
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const agent = (sessionId, k) => ({ sessionId, number: null, agent: k, name: `A${k}`, ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status: 'working', color: '#fff', files: [] });

  function scene(overrides = {}) {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const interrupted = [];
    const focused = [];
    const base = setup({
      maestro: () => true,
      orchestra: () => [agent('x', 1), agent('y', 2)],
      interrupt: (ptyId) => (interrupted.push(ptyId), true),
      focus: (sessionId) => focused.push(sessionId),
      pendingOrder,
      ...overrides,
    });
    return { ...base, pendingOrder, interrupted, focused, fire: () => timer?.() };
  }

  it('"interrompa o A2": held as "interromper o A2", then Esc to it', async () => {
    const { session, pendingOrder, interrupted, fire, texts } = scene();
    await session.onUtterance('interrompa o A2');
    expect(pendingOrder.pending().label).toBe('interromper o A2');
    fire();
    await tick();
    expect(interrupted).toEqual(['p-y']);
    expect(texts().at(-1)).toBe('Interrompi o A2.');
  });

  it('"vai pro A1" focuses it; an unknown agent says so', async () => {
    const { session, focused, texts } = scene();
    await session.onUtterance('vai pro A1');
    expect(focused).toEqual(['x']);
    expect(texts().at(-1)).toBe('Foco no A1.');
    await session.onUtterance('interrompa o A9');
    expect(texts().at(-1)).toBe('Não achei o A9.');
    const english = scene({ lang: () => 'en' });
    await english.session.onUtterance('interrompa o A9');
    expect(english.texts().at(-1)).toBe('No A9.');
  });

  it('"task 2" never lands on A2', async () => {
    const { session, interrupted, texts } = scene();
    await session.onUtterance('interrompa a task 2');
    expect(texts().at(-1)).toBe('Não achei músico na 2.');
    expect(interrupted).toEqual([]);
  });

  it('a prompt to a bound A1 is labelled by its name', async () => {
    const { session, pendingOrder } = scene({ findChat: () => 'x' });
    await session.onUtterance('fala com o chat x');
    await session.onUtterance('roda os testes');
    expect(pendingOrder.pending().label).toBe('mandar pro A1: roda os testes');
  });
});

describe('the plan a picked músico declares (the Maestro graph lights it up)', () => {
  it("the picked issue's músico is asked to end its plan with a Vizor-plano line", async () => {
    const { session, calls } = setup({ resolveTask: async () => ({ none: true, cwd: '/r' }) });
    await session.onUtterance('puxa a issue 142');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = calls.find(([name]) => name === 'new')[1].prompt;
    expect(prompt).toContain('Vizor-plano:');
    expect(prompt).toMatch(/Vizor-plano: \S+#\S+/);
  });
});

describe('voice session — the conducting gerente', async () => {
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const { createConductor } = await import('../src/main/maestro/conductor.js');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const musician = (sessionId, number, status = 'working') => ({ sessionId, number, agent: null, name: `#${number}`, root: '/r-wt/22', ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status, color: '#fff', files: [] });

  function scene(overrides = {}) {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const conductor = createConductor();
    const startedNow = [];
    const base = setup({
      maestro: () => true,
      orchestra: () => [musician('s22', 22)],
      interrupt: () => true,
      focus: () => {},
      pendingOrder,
      conductor,
      startOrderNow: (sessionId) => startedNow.push(sessionId),
      ...overrides,
    });
    return { ...base, conductor, startedNow, fire: () => timer?.() };
  }

  it('the conditional order is held, then given to the conductor', async () => {
    const { session, conductor, fire, texts, startedNow } = scene();
    await session.onUtterance('quando a 22 terminar, manda rodar os testes e abrir a PR');
    expect(conductor.ordersOf('s22')).toBeNull();
    fire();
    await tick();
    expect(conductor.ordersOf('s22')).toMatchObject({ label: 'manda rodar os testes e abrir a PR', waiting: 'turn' });
    expect(texts().at(-1)).toBe('Combinado: quando a 22 terminar, eu mando.');
    expect(startedNow).toEqual([]);
  });

  it('a músico already stopped gets it at once', async () => {
    const { session, fire, startedNow } = scene({ orchestra: () => [musician('s22', 22, 'done')] });
    await session.onUtterance('quando a 22 terminar, abre a PR');
    fire();
    await tick();
    expect(startedNow).toEqual(['s22']);
  });

  it('"chama um avaliador pra 22" opens a reviewer músico in its folder', async () => {
    const { session, fire, calls, texts } = scene();
    await session.onUtterance('chama um avaliador pra 22');
    fire();
    await tick();
    const opened = calls.find(([name]) => name === 'new');
    expect(opened[1].cwd).toBe('/r-wt/22');
    expect(opened[1].prompt).toContain('Revise o que a task 22 mudou');
    expect(calls.some(([name]) => name === 'link')).toBe(false); // review I6
    expect(texts().at(-1)).toBe('Um avaliador vai revisar a 22.');
  });

  it('the suggestion asks, and "sim" calls the reviewer', async () => {
    const { session, fire, calls, texts } = scene();
    session.onSuggestReviewer({ musician: musician('s22', 22), touched: 4, critical: 1 });
    expect(texts().at(-1)).toBe('A 22 mexeu em 4 arquivos, 1 crítico. Chamo um avaliador?');
    await session.onUtterance('sim');
    fire();
    await tick();
    expect(calls.find(([name]) => name === 'new')[1].prompt).toContain('task 22');
  });

  it('in English', async () => {
    const { session, fire, texts } = scene({ lang: () => 'en' });
    session.onSuggestReviewer({ musician: musician('s22', 22), touched: 3, critical: 0 });
    expect(texts().at(-1)).toBe('22 touched 3 files. Should I call a reviewer?');
    await session.onUtterance('quando a 22 terminar, abre a PR');
    fire();
    await tick();
    expect(texts().at(-1)).toBe("Got it: when 22 finishes, I'll send it.");
    session.onConductorAction({ type: 'done', sessionId: 's22', text: 'Done: abre a PR.' });
    expect(texts().at(-1)).toBe('Done: abre a PR.');
  });
});

describe('voice session — the conducting gerente, review fixes', async () => {
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const { createConductor } = await import('../src/main/maestro/conductor.js');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const musician = (sessionId, number, agent = null) => ({ sessionId, number, agent, name: number !== null ? `#${number}` : `A${agent}`, root: '/r', ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status: 'working', color: '#fff', files: [] });
  function scene(overrides = {}) {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const conductor = createConductor();
    const base = setup({ maestro: () => true, orchestra: () => [musician('s22', 22)], interrupt: () => true, focus: () => {}, pendingOrder, conductor, ...overrides });
    return { ...base, conductor, fire: () => timer?.() };
  }

  it('I4: a second order for the same músico says it replaced the first', async () => {
    const { session, fire, texts } = scene();
    await session.onUtterance('quando a 22 terminar, roda os testes');
    fire();
    await tick();
    await session.onUtterance('quando a 22 terminar, abre a PR');
    fire();
    await tick();
    expect(texts().at(-1)).toBe('Troquei a ordem da 22: quando ela terminar, eu mando a nova.');
  });

  it('I5: no offer while another question waits, nor for the chat the voice is with', async () => {
    const { session, texts, fire } = scene({ resolveTask: async () => ({ none: true, cwd: '/r' }) });
    await session.onUtterance('retoma a task 40');
    fire();
    await tick();
    const before = texts().length;
    session.onSuggestReviewer({ musician: musician('s22', 22), touched: 4, critical: 0 });
    expect(texts().length).toBe(before); // "Abro um chat novo pra 40?" is still the question
    const bound = scene();
    await bound.session.onUtterance('retoma a task 22');
    bound.fire();
    await tick();
    const count = bound.texts().length;
    bound.session.onSuggestReviewer({ musician: musician('s22', 22), touched: 4, critical: 0 });
    expect(bound.texts().length).toBe(count);
  });

  it('I5: "sim" reaches the very músico offered, even if A-numbers moved', async () => {
    let orchestra = [musician('x', null, 1)];
    const { session, fire, calls } = scene({ orchestra: () => orchestra });
    session.onSuggestReviewer({ musician: orchestra[0], touched: 3, critical: 0 });
    orchestra = [musician('y', null, 1), musician('x', null, 2)]; // a new tab took A1
    await session.onUtterance('sim');
    fire();
    await tick();
    expect(calls.find(([name]) => name === 'new')[1].prompt).toContain('task A2');
  });

  it('I6: the reviewer is not linked to the task (it is not another músico of it)', async () => {
    const { session, fire, calls } = scene();
    await session.onUtterance('chama um avaliador pra 22');
    fire();
    await tick();
    expect(calls.some(([name]) => name === 'link')).toBe(false);
  });
});

describe('voice session — memory (#163)', async () => {
  const { createRoutines } = await import('../src/main/voice/routines.js');
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const routinesFor = () => {
    const files = {};
    const store = createRoutines({ file: '/v/r.json', readFile: (f) => { if (!(f in files)) throw new Error('x'); return files[f]; }, writeFile: (f, c) => (files[f] = c), rename: (a, b) => ((files[b] = files[a]), delete files[a]) });
    return { save: (name, steps) => store.save('/r', name, steps), get: (name) => store.get('/r', name), list: () => store.list('/r'), remove: (name) => store.remove('/r', name) };
  };

  it('"onde paramos na 22?" answers with a short summary of where the chat stopped', async () => {
    const { session, texts } = setup({ summarize: async () => 'Faltava escolher o algoritmo de senha.' });
    await session.onUtterance('onde paramos na 22?');
    expect(texts().at(-1)).toBe('Na 22: Faltava escolher o algoritmo de senha.');
  });

  it('in economy mode, the first sentence of the last answer; no chat, it says so', async () => {
    const economy = setup({ economy: () => true });
    await economy.session.onUtterance('onde paramos na 22');
    expect(economy.texts().at(-1)).toBe('Na 22: Paramos na criptografia de senha.');
    const none = setup({ resolveTask: async () => ({ none: true }) });
    await none.session.onUtterance('onde paramos na 40');
    expect(none.texts().at(-1)).toBe('Não achei conversa da 40.');
  });

  it('a routine is saved, listed, run step by step and forgotten', async () => {
    const routines = routinesFor();
    const { session, texts, calls } = setup({ routines });
    await session.onUtterance('grava a rotina começar o dia: o que temos pra hoje, depois retoma a task 22');
    expect(texts().at(-1)).toBe('Gravei a rotina começar o dia: 2 passos.');
    await session.onUtterance('quais rotinas eu tenho?');
    expect(texts().at(-1)).toBe('Rotinas: começar o dia.');
    await session.onUtterance('roda a rotina começar o dia');
    await tick();
    expect(texts()).toContain('3 PRs abertas. O CI da 158 quebrou.');
    expect(calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);
    await session.onUtterance('esquece a rotina começar o dia');
    expect(texts().at(-1)).toBe('Esqueci a rotina começar o dia.');
    await session.onUtterance('roda a rotina começar o dia');
    expect(texts().at(-1)).toBe('Não tenho a rotina começar o dia.');
  });

  it('in the Maestro the routine is held once, and its steps run without their own wait', async () => {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    const routines = routinesFor();
    routines.save('dia', ['retoma a task 22']);
    const { session, calls } = setup({ routines, maestro: () => true, orchestra: () => [], pendingOrder });
    await session.onUtterance('roda a rotina dia');
    expect(pendingOrder.pending().label).toBe('rodar a rotina dia');
    timer();
    await tick();
    await tick();
    expect(calls).toContainEqual(['open', { sessionId: 's22', cwd: '/r' }]);
    expect(pendingOrder.pending()).toBeNull();
  });

  it('a routine never runs another routine', async () => {
    const routines = routinesFor();
    routines.save('a', ['roda a rotina a']);
    const { session, texts } = setup({ routines });
    await session.onUtterance('roda a rotina a');
    await tick();
    expect(texts()).toContain('Uma rotina não roda outra.');
  });
});

describe('voice session — routines, review fixes', async () => {
  const { createRoutines } = await import('../src/main/voice/routines.js');
  const { createPendingOrder } = await import('../src/main/maestro/pending-order.js');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const routinesFor = () => {
    const files = {};
    const store = createRoutines({ file: '/v/r.json', readFile: (f) => { if (!(f in files)) throw new Error('x'); return files[f]; }, writeFile: (f, c) => (files[f] = c), rename: (a, b) => ((files[b] = files[a]), delete files[a]) });
    return { save: (name, steps) => store.save('/r', name, steps), get: (name) => store.get('/r', name), list: () => store.list('/r'), remove: (name) => store.remove('/r', name) };
  };

  it('I1: a real utterance while a routine runs is held as usual, and it stops the routine', async () => {
    let timer = null;
    const pendingOrder = createPendingOrder({ setTimer: (callback) => (timer = callback), clearTimer: () => (timer = null) });
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const routines = routinesFor();
    routines.save('dia', ['o que temos pra hoje', 'retoma a task 22']);
    const { session, calls, texts } = setup({ routines, maestro: () => true, orchestra: () => [], pendingOrder, ghDigest: async () => (await slow, { speech: 'ok', lines: [] }) });
    await session.onUtterance('roda a rotina dia');
    timer();
    await tick();
    // The routine is waiting on its first step; the user speaks an order.
    await session.onUtterance('retoma a task 40');
    expect(pendingOrder.pending().label).toBe('retomar a 40');
    release();
    await tick();
    await tick();
    expect(texts()).toContain('Parei a rotina dia.');
    expect(calls.some(([name, target]) => name === 'open' && target.sessionId === 's22')).toBe(false);
  });

  it('I2: back-to-back prompts to a busy chat all arrive, in order', async () => {
    const delivered = [];
    let busy = true;
    const { session } = setup({ deliverPrompt: async (sessionId, text) => (busy ? 'hold' : (delivered.push(text), 'sent')) });
    await session.onUtterance('retoma a task 22');
    await session.onUtterance('roda os testes');
    await session.onUtterance('abre a PR');
    busy = false;
    await session.onSessionStop({ id: 's22', lastMessage: 'Feito.' });
    await session.onSessionStop({ id: 's22', lastMessage: 'Feito.' });
    expect(delivered).toEqual(['roda os testes', 'abre a PR']);
  });

  it('I3: a step that asks a question stops the routine there and says where', async () => {
    const routines = routinesFor();
    routines.save('dia', ['retoma a task 40', 'roda os testes']);
    const { session, texts, calls } = setup({ routines, resolveTask: async () => ({ none: true, cwd: '/r' }) });
    await session.onUtterance('roda a rotina dia');
    await tick();
    expect(texts().at(-1)).toBe('Parei a rotina dia no passo 1: responda e siga à mão.');
    expect(calls.some(([name]) => name === 'deliver')).toBe(false);
    await session.onUtterance('sim');
    expect(calls).toContainEqual(['new', { cwd: '/r', prompt: 'Vamos trabalhar na issue #40.' }]);
  });

  it('I4: a routine that cannot be read says how to say it', async () => {
    const { session, texts } = setup({ routines: routinesFor() });
    await session.onUtterance('grava a rotina');
    expect(texts().at(-1)).toBe('Pra gravar, diga: grava a rotina <nome>: passo, depois passo.');
  });
});

describe('voice session — "dê ela para um músico" (live test)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  it('the issue last talked about, yours or the gerente\'s, is the one handed over', async () => {
    const { session, calls } = setup({ resolveTask: async () => ({ none: true, cwd: '/r' }), askManager: async () => 'A 162 é sobre o gerente orquestrador.' });
    await session.onUtterance('me fala da issue 162');
    await session.onUtterance('E dê ela para um músico para que ele possa desenvolvê-la.');
    await tick();
    expect(calls.find(([name]) => name === 'new')[1].prompt).toContain('issue #162');
  });

  it('with no issue talked about, it asks which', async () => {
    const { session, texts } = setup();
    await session.onUtterance('passa essa pra um chat');
    expect(texts().at(-1)).toBe('Qual issue? Diga, por exemplo: puxa a issue 162.');
  });
});
