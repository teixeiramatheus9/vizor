import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildPrompt,
  fallbackMessage,
  humanizeNotification,
  parseVoiceResponse,
  generateManagerMessage,
  WAITING_PHRASES, isPermissionAsk } from '../src/main/manager-voice.js';

function fakeSpawn({ stdout = '', exitCode = 0, delayMs = 0, failToStart = false } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    if (failToStart) {
      setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
    } else {
      setTimeout(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', exitCode);
      }, delayMs);
    }
    return child;
  };
  return { spawnFn, calls };
}

describe('manager voice', () => {
  it('builds a prompt containing project name and last message', () => {
    const prompt = buildPrompt('projeto-alpha', 'fixed the login bug');
    expect(prompt).toContain('projeto-alpha');
    expect(prompt).toContain('fixed the login bug');
    expect(prompt).toContain('"title"');
  });

  it('parses JSON out of noisy stdout', () => {
    const parsed = parseVoiceResponse('blah\n{"title":"Fix login","message":"Opa, terminou po!"}\n');
    expect(parsed).toEqual({ title: 'Fix login', message: 'Opa, terminou po!' });
  });

  it('returns null for invalid or incomplete JSON', () => {
    expect(parseVoiceResponse('no json here')).toBeNull();
    expect(parseVoiceResponse('{"title":"only title"}')).toBeNull();
  });

  it('humanizes permission notifications keeping the tool name', () => {
    const result = humanizeNotification('Claude needs your permission to use Bash');
    expect(result).toContain('Bash');
    expect(result).toContain('permissão');
  });

  it('turns waiting notifications into a casual pt-BR phrase', () => {
    expect(humanizeNotification('Claude is waiting for your input', () => 0)).toBe(
      WAITING_PHRASES[0],
    );
    expect(WAITING_PHRASES).toContain(humanizeNotification(undefined));
  });

  it('fallbackMessage interpolates the project name', () => {
    const fallback = fallbackMessage('projeto-alpha', () => 0);
    expect(fallback.message).toContain('projeto-alpha');
    // no title on purpose: a generic one would overwrite the chat's subject
    expect(fallback.title).toBeUndefined();
  });

  it('generateManagerMessage returns parsed AI output, token usage and sets the recursion guard', async () => {
    const cliJson = JSON.stringify({
      result: '{"title":"Deploy","message":"Acabou!"}',
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const { spawnFn, calls } = fakeSpawn({ stdout: cliJson });
    const result = await generateManagerMessage({
      projectName: 'proj',
      lastAssistantMessage: 'deployed ok',
      spawnFn,
    });
    expect(result).toEqual({ title: 'Deploy', message: 'Acabou!', tokensUsed: 120 });
    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toContain('--model');
    expect(calls[0].args).toContain('--output-format');
    expect(calls[0].options.env.CLAUDE_MANAGER_INTERNAL).toBe('1');
  });

  it('counts tokens even when the inner reply fails to parse', async () => {
    const cliJson = JSON.stringify({
      result: 'texto solto sem json',
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const { spawnFn } = fakeSpawn({ stdout: cliJson });
    const result = await generateManagerMessage({
      projectName: 'proj',
      lastAssistantMessage: null,
      spawnFn,
    });
    expect(result.message).toContain('proj'); // fallback phrase
    expect(result.tokensUsed).toBe(60); // but the spend is real
  });

  it('falls back on non-zero exit, on garbage output, and on spawn failure', async () => {
    for (const scenario of [
      fakeSpawn({ exitCode: 1 }),
      fakeSpawn({ stdout: 'not json' }),
      fakeSpawn({ failToStart: true }),
    ]) {
      const result = await generateManagerMessage({
        projectName: 'proj',
        lastAssistantMessage: null,
        spawnFn: scenario.spawnFn,
      });
      expect(result.message).toContain('proj');
      expect(result.tokensUsed).toBe(0);
    }
  });

  it('falls back when the CLI exceeds the timeout', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '{"result":"x","usage":{}}', delayMs: 200 });
    const result = await generateManagerMessage({
      projectName: 'proj',
      lastAssistantMessage: null,
      timeoutMs: 20,
      spawnFn,
    });
    expect(result.message).toContain('proj');
  });
});


// The halo needs to know BEFORE humanizeNotification rewrites the message —
// the raw "permission to use X" is gone right after.
describe('isPermissionAsk', () => {
  it('spots the permission notification', () => {
    expect(isPermissionAsk('Claude needs your permission to use Bash')).toBe(true);
  });

  it('is false for the plain waiting notification', () => {
    expect(isPermissionAsk('Claude is waiting for your input')).toBe(false);
    expect(isPermissionAsk(undefined)).toBe(false);
  });
});

describe('in English, for an English voice', () => {
  it('the prompt asks for the message in casual American English; the title stays pt-BR (it names the chat on screen)', () => {
    const prompt = buildPrompt('vizor', 'Fiz o login.', 'en');
    expect(prompt).toContain('"message": 1 to 2 sentences in casual American English');
    expect(prompt).toContain('"title": máximo 6 palavras, em pt-BR');
    expect(buildPrompt('vizor', 'x')).not.toContain('American English');
  });

  it('fallbacks and waiting lines in English', () => {
    expect(fallbackMessage('vizor', () => 0, 'en').message).toBe("Hey, that task in 'vizor' is done, take a look!");
    expect(humanizeNotification('Claude is waiting for your input', () => 0, 'en')).toBe('Take a look here and tell me how to go on!');
    expect(humanizeNotification('Claude needs your permission to use Bash', () => 0, 'en')).toBe('It wants your permission to use Bash, allow it?');
  });
});
