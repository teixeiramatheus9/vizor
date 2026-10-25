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
    expect(route('não, é pty-host')).toEqual({ type: 'correct', meant: 'pty-host' });
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
