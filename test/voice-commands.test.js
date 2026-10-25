import { describe, it, expect } from 'vitest';
import { routeUtterance } from '../src/main/voice/commands.js';

const manager = { target: 'manager', pendingAsk: false, hasLastReply: false, pendingConfirm: false };
const chat = { ...manager, target: 'chat' };
const route = (text, context = manager) => routeUtterance(text, context);

describe('routeUtterance — Vizor commands', () => {
  it('status of the project', () => {
    expect(route('o que temos pra hoje?')).toEqual({ type: 'status' });
    expect(route('Qual o status do projeto')).toEqual({ type: 'status' });
    expect(route('como tá o CI')).toEqual({ type: 'status' });
  });

  it('resume a task by number, spoken or written', () => {
    expect(route('retoma a task vinte e dois')).toEqual({ type: 'resume-task', number: 22 });
    expect(route('abre a issue 161')).toEqual({ type: 'resume-task', number: 161 });
    expect(route('volta pra PR doze')).toEqual({ type: 'resume-task', number: 12 });
  });

  it('switch who the voice talks to', () => {
    expect(route('fala com o chat da 22')).toEqual({ type: 'talk-to-chat', query: '22' });
    expect(route('fala com o chat do pty-host')).toEqual({ type: 'talk-to-chat', query: 'pty-host' });
    expect(route('volta pro gerente', chat)).toEqual({ type: 'talk-to-manager' });
    expect(route('Vizor, volta pro gerente', chat)).toEqual({ type: 'talk-to-manager' });
  });

  it('workspace', () => {
    expect(route('esconde o chat')).toEqual({ type: 'workspace', action: 'hide-chat' });
    expect(route('mostra o chat', chat)).toEqual({ type: 'workspace', action: 'show-chat' });
    expect(route('mostra o diff')).toEqual({ type: 'workspace', action: 'show-diff' });
    expect(route('abre o arquivo pty-host.js')).toEqual({ type: 'workspace', action: 'open-file', file: 'pty-host.js' });
  });

  it('navigation only when there is a reply to walk', () => {
    const withReply = { ...manager, hasLastReply: true };
    expect(route('lê os tópicos', withReply)).toEqual({ type: 'navigate', action: 'topics' });
    expect(route('próximo', withReply)).toEqual({ type: 'navigate', action: 'next' });
    expect(route('repete', withReply)).toEqual({ type: 'navigate', action: 'repeat' });
    expect(route('detalha o segundo', withReply)).toEqual({ type: 'navigate', action: 'detail', index: 2 });
    expect(route('próximo')).toEqual({ type: 'ask-manager', text: 'próximo' });
  });

  it('stop, dictation', () => {
    expect(route('para')).toEqual({ type: 'stop' });
    expect(route('cala a boca', chat)).toEqual({ type: 'stop' });
    expect(route('vou ditar')).toEqual({ type: 'dictate' });
  });

  it('answers the trava only when it is asking', () => {
    const asking = { ...manager, pendingAsk: true };
    expect(route('libera', asking)).toEqual({ type: 'guard', choice: 'liberar' });
    expect(route('libera nesta sessão', asking)).toEqual({ type: 'guard', choice: 'liberar-sessao' });
    expect(route('barra', asking)).toEqual({ type: 'guard', choice: 'barrar' });
    expect(route('libera')).toEqual({ type: 'ask-manager', text: 'libera' });
  });

  it('yes/no only when the gerente asked something', () => {
    const asked = { ...manager, pendingConfirm: true };
    expect(route('sim', asked)).toEqual({ type: 'confirm', yes: true });
    expect(route('não, deixa', asked)).toEqual({ type: 'confirm', yes: false });
    expect(route('sim', chat)).toEqual({ type: 'prompt', text: 'sim' });
  });

  it('a correction of what it heard', () => {
    expect(route('não, é pty-host', { ...manager, canCorrect: true })).toEqual({ type: 'correct', meant: 'pty-host' });
  });
});

describe('routeUtterance — prompts vs commands (review focus)', () => {
  it('a prompt that only contains a command word goes to the chat', () => {
    expect(route('para de usar var nesse arquivo', chat)).toEqual({ type: 'prompt', text: 'para de usar var nesse arquivo' });
    expect(route('mostra como funciona o login', chat)).toEqual({ type: 'prompt', text: 'mostra como funciona o login' });
    expect(route('para', chat)).toEqual({ type: 'stop' });
  });

  it('with the gerente, anything else is a question for it', () => {
    expect(route('mostra como funciona o login')).toEqual({ type: 'ask-manager', text: 'mostra como funciona o login' });
  });

  it('"Vizor, …" from a chat is for the gerente even when it is not a command', () => {
    expect(route('Vizor, quantos chats estão rodando?', chat)).toEqual({ type: 'ask-manager', text: 'quantos chats estão rodando?' });
  });
});

describe('routeUtterance — final review fixes', () => {
  it('I1: a correction only right after an utterance, and short', () => {
    expect(route('não, é pty-host', { ...chat, canCorrect: true })).toEqual({ type: 'correct', meant: 'pty-host' });
    expect(route('não é pra usar var aqui', chat)).toEqual({ type: 'prompt', text: 'não é pra usar var aqui' });
    expect(route('não, é pra trocar tudo pelo argon2 e rodar os testes', { ...chat, canCorrect: true })).toEqual({
      type: 'prompt',
      text: 'não, é pra trocar tudo pelo argon2 e rodar os testes',
    });
  });

  it('I1: a bare "não" goes to the chat even with a trava card open', () => {
    expect(route('não', { ...chat, pendingAsk: true })).toEqual({ type: 'prompt', text: 'não' });
    expect(route('barra', { ...chat, pendingAsk: true })).toEqual({ type: 'guard', choice: 'barrar' });
  });

  it('I8: picking one of the offered conversations', () => {
    const choosing = { ...manager, pendingChoice: true };
    expect(route('a segunda', choosing)).toEqual({ type: 'choose', index: 2 });
    expect(route('o primeiro', choosing)).toEqual({ type: 'choose', index: 1 });
    expect(route('a segunda')).toEqual({ type: 'ask-manager', text: 'a segunda' });
  });
});

describe('routeUtterance — the wake word as Whisper writes it', () => {
  it('drops a first word that sounds like "Vizor" (spike: Pfizer, Fizer, Bizer, Aisor, Visor)', () => {
    for (const heard of ['Pfizer retoma a task 22', 'Fizer, retoma a task 22', 'Bizer retoma a task 22', 'Aisor, retoma a task 22', 'Visor retoma a task 22', 'Vizer, retoma a task 22'])
      expect(route(heard), heard).toEqual({ type: 'resume-task', number: 22 });
  });

  it('the pre-roll may catch a short word before it (real transcript: "no Pfizer, o que temos para hoje")', () => {
    expect(route('no Pfizer, o que temos para hoje.')).toEqual({ type: 'status' });
    expect(route('é Visor retoma a task 22')).toEqual({ type: 'resume-task', number: 22 });
  });

  it('keeps an ordinary first word', () => {
    expect(route('vizinho barulhento', chat)).toEqual({ type: 'prompt', text: 'vizinho barulhento' });
    expect(route('fiz o deploy', chat)).toEqual({ type: 'prompt', text: 'fiz o deploy' });
  });
});

describe('routeUtterance — GitHub questions (live test)', () => {
  it('asking about the GitHub in everyday words is the status command', () => {
    for (const phrase of [
      'quantas issues a gente tem abertas no GitHub?',
      'quantas issues tem abertas',
      'o que tá rolando no GitHub',
      'o que tá rolando',
      'como tá o GitHub',
      'tem PR aberta?',
      'quais PRs estão abertas',
    ])
      expect(route(phrase), phrase).toEqual({ type: 'status' });
  });
});

describe('routeUtterance — how the models heard the user (voz2 recordings)', () => {
  it('"vou ditar" as every model misheard it', () => {
    for (const heard of ['vou ditar', 'Vou de tentar.', 'vou de ter', 'vou de terra', 'Vou editar.', 'voo de tar', 'modo ditado'])
      expect(route(heard), heard).toEqual({ type: 'dictate' });
  });

  it('"Vizor" heard as Weiser or Advisor', () => {
    expect(route('Weiser, o que temos para hoje?')).toEqual({ type: 'status' });
    expect(route('Advisor, esconde o chat.')).toEqual({ type: 'workspace', action: 'hide-chat' });
  });

  it('"lê os tópicos" also as "leus tópicos"', () => {
    expect(route('Leus tópicos.', { ...manager, hasLastReply: true })).toEqual({ type: 'navigate', action: 'topics' });
  });
});

describe('routeUtterance — the full pipeline on the voz2 recordings', () => {
  it('"task #161" as Parakeet writes it', () => {
    expect(route('retoma a task #161')).toEqual({ type: 'resume-task', number: 161 });
  });

  it('"abre o arquivo X e me explica…" is a prompt for the chat, not the open-file command', () => {
    expect(route('Abre o arquivo pty-host.js e me explica o que ele faz.', chat)).toEqual({
      type: 'prompt',
      text: 'Abre o arquivo pty-host.js e me explica o que ele faz.',
    });
    expect(route('abre o arquivo pty-host.js', chat)).toEqual({ type: 'workspace', action: 'open-file', file: 'pty-host.js' });
  });
});

describe('routeUtterance — Maestro', () => {
  it('interrupt only with the specific phrase', () => {
    expect(routeUtterance('Vizor, interrompa a task 22')).toEqual({ type: 'interrupt', number: 22 });
    expect(routeUtterance('interrompe a tarefa vinte e dois')).toEqual({ type: 'interrupt', number: 22 });
    expect(routeUtterance('interromper a issue 7')).toEqual({ type: 'interrupt', number: 7 });
    expect(routeUtterance('interrompa')).toMatchObject({ type: 'ask-manager' });
    expect(routeUtterance('para a 22')).toMatchObject({ type: 'ask-manager' });
  });

  it('focus a músico and switch the mode', () => {
    expect(routeUtterance('vai pra 31')).toEqual({ type: 'focus', number: 31 });
    expect(routeUtterance('foca na task 31')).toEqual({ type: 'focus', number: 31 });
    expect(routeUtterance('Vizor, ative o modo Maestro')).toEqual({ type: 'maestro', on: true });
    expect(routeUtterance('ativa o modo maestro')).toEqual({ type: 'maestro', on: true });
    expect(routeUtterance('desative o modo maestro')).toEqual({ type: 'maestro', on: false });
    expect(routeUtterance('sai do modo maestro')).toEqual({ type: 'maestro', on: false });
    // Only the explicit request turns it on: a passing mention never does.
    expect(routeUtterance('modo maestro')).toMatchObject({ type: 'ask-manager' });
    expect(routeUtterance('o que é o modo maestro?')).toMatchObject({ type: 'ask-manager' });
  });

  it('a pending order is cancelled or sent now, only while one is pending', () => {
    for (const said of ['cancela', 'não, espera', 'espera', 'não']) expect(routeUtterance(said, { pendingOrder: true })).toEqual({ type: 'order', action: 'cancel' });
    for (const said of ['manda', 'pode', 'pode mandar']) expect(routeUtterance(said, { pendingOrder: true })).toEqual({ type: 'order', action: 'now' });
    expect(routeUtterance('cancela')).not.toMatchObject({ type: 'order' });
  });
});

describe('routeUtterance — Maestro, live test', () => {
  it('"ativar modo maestro" without the article turns it on too', () => {
    expect(routeUtterance('Weiser, ativar modo maestro.')).toEqual({ type: 'maestro', on: true });
    expect(routeUtterance('ative modo maestro')).toEqual({ type: 'maestro', on: true });
    expect(routeUtterance('desativar modo maestro')).toEqual({ type: 'maestro', on: false });
  });
});

describe('routeUtterance — the músicos act on the GitHub', () => {
  it('pick up an issue, get a PR reviewed', () => {
    expect(routeUtterance('Vizor, puxa a issue 142')).toEqual({ type: 'pick-issue', number: 142 });
    expect(routeUtterance('pega a issue cento e quarenta e dois')).toEqual({ type: 'pick-issue', number: 142 });
    expect(routeUtterance('revisa a PR 166')).toEqual({ type: 'review-pr', number: 166 });
    expect(routeUtterance('manda revisar a pr 166')).toEqual({ type: 'review-pr', number: 166 });
    expect(routeUtterance('pede revisão da PR 166')).toEqual({ type: 'review-pr', number: 166 });
    expect(routeUtterance('puxa uma das issues que a gente tem')).toMatchObject({ type: 'ask-manager' });
  });
});

describe('routeUtterance — músicos without a task are A1, A2…', () => {
  it('interrupt and focus by agent name', () => {
    expect(routeUtterance('Vizor, interrompa o A1')).toEqual({ type: 'interrupt', agent: 1 });
    expect(routeUtterance('interrompe o a 2')).toEqual({ type: 'interrupt', agent: 2 });
    expect(routeUtterance('interrompa o agente 3')).toEqual({ type: 'interrupt', agent: 3 });
    expect(routeUtterance('vai pro A2')).toEqual({ type: 'focus', agent: 2 });
    expect(routeUtterance('foca no a2')).toEqual({ type: 'focus', agent: 2 });
    expect(routeUtterance('vai pra a2')).toEqual({ type: 'focus', agent: 2 });
  });

  it('"vai pra a 2" with a space is the task 2 (Portuguese article), as before', () => {
    expect(routeUtterance('vai pra a 2')).toEqual({ type: 'focus', number: 2 });
    expect(routeUtterance('interrompa a task 2')).toEqual({ type: 'interrupt', number: 2 });
  });
});

describe('routeUtterance — the conducting gerente', () => {
  it('quando a 22 terminar, … is a conditional order', () => {
    expect(routeUtterance('Vizor, quando a 22 terminar, manda rodar os testes e abrir a PR')).toEqual({ type: 'when-done', number: 22, text: 'manda rodar os testes e abrir a PR' });
    expect(routeUtterance('quando a task 7 acabar abre a PR')).toEqual({ type: 'when-done', number: 7, text: 'abre a PR' });
  });

  it('quando o A1 acabar …', () => {
    expect(routeUtterance('quando o A1 acabar, roda os testes')).toEqual({ type: 'when-done', agent: 1, text: 'roda os testes' });
  });

  it('chama um avaliador pra 22 / pro A1', () => {
    expect(routeUtterance('Vizor, chama um avaliador pra 22')).toEqual({ type: 'call-reviewer', number: 22 });
    expect(routeUtterance('chame um avaliador para a task 22')).toEqual({ type: 'call-reviewer', number: 22 });
    expect(routeUtterance('chama um avaliador pro A1')).toEqual({ type: 'call-reviewer', agent: 1 });
  });
});

describe('routeUtterance — memory (#163)', () => {
  it('where did we stop on a task', () => {
    expect(routeUtterance('Vizor, onde paramos na 22?')).toEqual({ type: 'where-stopped', number: 22 });
    expect(routeUtterance('onde a gente parou na task vinte e dois')).toEqual({ type: 'where-stopped', number: 22 });
  });

  it('save, run, list and forget a routine', () => {
    expect(routeUtterance('Vizor, grava a rotina começar o dia: o que temos pra hoje, depois revisa a PR 166')).toEqual({
      type: 'save-routine',
      name: 'começar o dia',
      steps: ['o que temos pra hoje', 'revisa a PR 166'],
    });
    expect(routeUtterance('salva uma rotina fim do dia: o que ficou aberto; e depois desative o modo maestro')).toEqual({
      type: 'save-routine',
      name: 'fim do dia',
      steps: ['o que ficou aberto', 'desative o modo maestro'],
    });
    expect(routeUtterance('roda a rotina começar o dia')).toEqual({ type: 'run-routine', name: 'começar o dia' });
    expect(routeUtterance('começa a rotina de começar o dia')).toEqual({ type: 'run-routine', name: 'começar o dia' });
    expect(routeUtterance('quais rotinas eu tenho?')).toEqual({ type: 'list-routines' });
    expect(routeUtterance('esquece a rotina fim do dia')).toEqual({ type: 'forget-routine', name: 'fim do dia' });
  });
});

describe('routeUtterance — routines, review fixes', () => {
  it('a "quando … terminar" step stays whole; ";" always splits', () => {
    expect(routeUtterance('grava a rotina fim: quando a 22 terminar, roda os testes e depois abre a PR; desative o modo maestro')).toEqual({
      type: 'save-routine',
      name: 'fim',
      steps: ['quando a 22 terminar, roda os testes e depois abre a PR', 'desative o modo maestro'],
    });
  });

  it('without a colon: "com os passos" or the first comma; unclear, it says how', () => {
    expect(routeUtterance('grava a rotina dia com os passos o que temos pra hoje, depois revisa a PR 166')).toEqual({
      type: 'save-routine',
      name: 'dia',
      steps: ['o que temos pra hoje', 'revisa a PR 166'],
    });
    expect(routeUtterance('grava a rotina dia, o que temos pra hoje')).toEqual({ type: 'save-routine', name: 'dia', steps: ['o que temos pra hoje'] });
    expect(routeUtterance('grava a rotina')).toEqual({ type: 'save-routine-invalid' });
  });

  it('"do deploy" and "deploy" are the same routine to save, run and forget', () => {
    expect(routeUtterance('grava a rotina do deploy: roda os testes').name).toBe('deploy');
    expect(routeUtterance('roda a rotina do deploy').name).toBe('deploy');
    expect(routeUtterance('esquece a rotina do deploy').name).toBe('deploy');
  });
});

describe('routeUtterance — starting work on an issue, said naturally (live test)', () => {
  it("the user's own phrases pick the issue up", () => {
    expect(routeUtterance('Advisor, vamos pegar issue #162 e analisar para ver o que podemos fazer?')).toEqual({ type: 'pick-issue', number: 162 });
    expect(routeUtterance('Sim, pegue a issue #162 e vamos começar a desenvolvê-la.', { pendingConfirm: true })).toEqual({ type: 'pick-issue', number: 162 });
    expect(routeUtterance('bora implementar a task 40')).toEqual({ type: 'pick-issue', number: 40 });
    expect(routeUtterance('quero trabalhar na issue 7')).toEqual({ type: 'pick-issue', number: 7 });
  });

  it('"dê ela para um músico" hands over the issue last talked about', () => {
    expect(routeUtterance('E dê ela para um músico para que ele possa desenvolvê-la.')).toEqual({ type: 'pick-issue', number: null });
    expect(routeUtterance('passa essa pra um chat')).toEqual({ type: 'pick-issue', number: null });
  });

  it('reviewing, closing or assigning is not picking up', () => {
    expect(routeUtterance('vamos revisar a issue 162')).not.toMatchObject({ type: 'pick-issue' });
    expect(routeUtterance('pode fechar a issue 162')).not.toMatchObject({ type: 'pick-issue' });
    expect(routeUtterance('atribui a issue 162 pra mim')).not.toMatchObject({ type: 'pick-issue' });
  });
});

describe('routeUtterance — "issue" as the transcriber writes it (live test)', () => {
  it('"isue", "issu" and "issues" are issues too', () => {
    expect(routeUtterance('Vamos desenvolver a isue 169.')).toEqual({ type: 'pick-issue', number: 169 });
    expect(routeUtterance('Sim, pega isue 169 para desenvolvermos.')).toEqual({ type: 'pick-issue', number: 169 });
    expect(routeUtterance('puxa a issu 169')).toEqual({ type: 'pick-issue', number: 169 });
  });
});

describe('the issue number, however it was transcribed (live test)', async () => {
  const { issueNumberIn } = await import('../src/main/voice/commands.js');
  it('the phrases from the log', () => {
    expect(routeUtterance('Advisor, pega eixo e um meia 9 para a gente desenvolver.')).toEqual({ type: 'pick-issue', number: 169 });
    expect(routeUtterance('Vamos pegar a isue 1, 6, 9.')).toEqual({ type: 'pick-issue', number: 169 });
    expect(routeUtterance('Weiser, pega eixe 169.')).toEqual({ type: 'pick-issue', number: 169 });
    expect(routeUtterance('pega a 169 pra desenvolver')).toEqual({ type: 'pick-issue', number: 169 });
  });

  it('issueNumberIn reads digits, spoken digits, "meia" and "160 e nove"', () => {
    expect(issueNumberIn('issue 160 e nove')).toBe(169);
    expect(issueNumberIn('eixo um meia nove')).toBe(169);
    expect(issueNumberIn('a task 22 e depois abre a pr')).toBe(22);
    expect(issueNumberIn('issue 162 e analisar')).toBe(162);
    expect(issueNumberIn('nada aqui')).toBeNull();
  });

  it('a number alone is not an issue without "puxa/pega" right before it', () => {
    expect(routeUtterance('vamos fazer o deploy em 2 minutos')).not.toMatchObject({ type: 'pick-issue' });
  });
});
