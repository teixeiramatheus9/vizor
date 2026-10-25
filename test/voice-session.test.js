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
