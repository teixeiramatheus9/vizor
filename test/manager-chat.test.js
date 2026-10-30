import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildSessionsDigest,
  findMentionedSession,
  buildChatPrompt,
  askManager,
} from '../src/main/manager-chat.js';

const session = (overrides = {}) => ({
  id: 's1',
  projectName: 'projeto-alpha',
  title: 'Fix do relatório',
  promptPreview: 'corrige o relatório de vendas',
  status: 'done',
  managerMessage: 'Terminei o fix!',
  updatedAt: 1000,
  ...overrides,
});

function fakeSpawn({ stdout = '', exitCode = 0, failToStart = false } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (failToStart) return child.emit('error', new Error('ENOENT'));
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    }, 0);
    return child;
  };
  return { spawnFn, calls };
}

describe('buildSessionsDigest', () => {
  it('renders one compact line per session with status, theme and age', () => {
    const digest = buildSessionsDigest([session()], 61000);
    expect(digest).toContain('[terminou]');
    expect(digest).toContain('Fix do relatório');
    expect(digest).toContain('há 1min');
    expect(digest).toContain('Terminei o fix!');
  });

  it('says when there are no sessions', () => {
    expect(buildSessionsDigest([])).toContain('Nenhuma sessão');
  });
});

describe('findMentionedSession', () => {
  it('finds a session by project name mention', () => {
    expect(findMentionedSession([session()], 'como tá o projeto-alpha?')?.id).toBe('s1');
  });

  it('returns null when nothing is mentioned', () => {
    expect(findMentionedSession([session()], 'resume o dia aí')).toBeNull();
  });
});

describe('buildChatPrompt', () => {
  it('includes digest, capped history and the user message', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? 'manager' : 'user',
      text: `msg ${index}`,
    }));
    const prompt = buildChatPrompt({
      digest: 'DIGEST-AQUI',
      history,
      userMessage: 'e aí, tudo certo?',
    });
    expect(prompt).toContain('DIGEST-AQUI');
    expect(prompt).toContain('e aí, tudo certo?');
    expect(prompt).not.toContain('msg 0'); // history capped at the last 6
    expect(prompt).toContain('msg 9');
  });

  it('includes the transcript excerpt only when provided', () => {
    expect(buildChatPrompt({ digest: 'd', userMessage: 'oi' })).not.toContain('sessão citada');
    expect(
      buildChatPrompt({ digest: 'd', userMessage: 'oi', transcriptExcerpt: 'fiz X e Y' }),
    ).toContain('fiz X e Y');
  });
});

describe('askManager', () => {
  it('returns the CLI reply with token usage and sets the recursion guard', async () => {
    const cliJson = JSON.stringify({
      result: 'Tudo em dia, chefe!',
      usage: { input_tokens: 200, output_tokens: 30 },
    });
    const { spawnFn, calls } = fakeSpawn({ stdout: cliJson });
    const result = await askManager({
      sessions: [session()],
      history: [],
      userMessage: 'como estamos?',
      spawnFn,
    });
    expect(result).toEqual({ reply: 'Tudo em dia, chefe!', tokensUsed: 230 });
    expect(calls[0].options.env.CLAUDE_MANAGER_INTERNAL).toBe('1');
    expect(calls[0].args).toContain('--output-format');
  });

  it('returns a friendly fallback on failure', async () => {
    const { spawnFn } = fakeSpawn({ failToStart: true });
    const result = await askManager({ sessions: [], history: [], userMessage: 'oi', spawnFn });
    expect(result.reply).toContain('travei');
    expect(result.tokensUsed).toBe(0);
  });
});


describe('aliases in the digest and mentions (issue #63)', () => {
  const aliased = {
    id: 's1',
    projectName: 'vizor',
    displayName: 'API do site',
    title: null,
    promptPreview: null,
    status: 'done',
    managerMessage: null,
    updatedAt: 1000,
  };

  it('the digest introduces the chat by its nickname', () => {
    expect(buildSessionsDigest([aliased], 61000)).toContain('API do site');
  });

  it('mentioning the nickname OR the folder name finds the chat', () => {
    expect(findMentionedSession([aliased], 'como está o API do site?')?.id).toBe('s1');
    expect(findMentionedSession([aliased], 'e o chat da pasta vizor ali?')?.id).toBe('s1');
  });
});

describe('the gerente in English, for an English voice', () => {
  it('asks for a casual American English answer; the default stays pt-BR', () => {
    const english = buildChatPrompt({ digest: '-', userMessage: 'o que tá rolando?', lang: 'en' });
    expect(english).toContain('Reply in casual American English');
    expect(english).toContain('Want me to resume task N?');
    expect(english).not.toContain('Responda em pt-BR');
    expect(buildChatPrompt({ digest: '-', userMessage: 'oi' })).toContain('Responda em pt-BR');
  });
});

describe('the gerente reads, the músicos act (#159)', () => {
  it('proposes actions in fixed phrases the voice detects, in either language', () => {
    const pt = buildChatPrompt({ digest: '-', userMessage: 'puxa uma issue' });
    expect(pt).toContain('Quer que eu puxe a issue N?');
    expect(pt).toContain('Quer que eu peça revisão da PR N?');
    expect(pt).toContain('Quer que eu retome a N?');
    expect(pt).toContain('Você só lê o GitHub');
    const en = buildChatPrompt({ digest: '-', userMessage: 'x', lang: 'en' });
    expect(en).toContain('Want me to pick up issue N?');
    expect(en).toContain('Want me to get PR N reviewed?');
  });
});

describe('the gerente never offers to assign (live test)', () => {
  it('to start work on an issue it offers to pick it up', () => {
    const prompt = buildChatPrompt({ digest: '-', userMessage: 'vamos pegar a 162' });
    expect(prompt).toContain('Nunca ofereça atribuir');
    expect(buildChatPrompt({ digest: '-', userMessage: 'x', lang: 'en' })).toContain('Never offer to assign');
  });
});
