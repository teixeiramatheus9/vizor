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
