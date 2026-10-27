import { describe, it, expect } from 'vitest';
import { GUARD_CHOICES, createGuardAsks, isGuardChoice } from '../src/main/guard-asks.js';

let counter = 0;
const request = (overrides = {}) => ({
  type: 'guard-ask',
  sessionId: 's1',
  cwd: '/repo',
  tool: 'Bash',
  input: { command: 'kubectl --context prod apply' },
  ruleId: 'prod',
  ruleSource: 'quando ver PROD pergunte',
  explain: 'menciona PROD',
  irreversible: false,
  target: 'kubectl --context prod apply',
  ...overrides,
});

function setup() {
  const asks = createGuardAsks({ now: () => 1000, newId: () => `a${++counter}` });
  const replies = [];
  const reply = () => {
    const fn = (answer) => replies.push(answer);
    fn.onClose = () => {};
    return fn;
  };
  return { asks, replies, reply };
}

describe('guard asks', () => {
  it('holds an ask until it is answered, and replies to the guard', () => {
    const { asks, replies, reply } = setup();
    const { id } = asks.add(request(), reply());
    expect(asks.pending().map((ask) => ask.id)).toEqual([id]);
    expect(asks.answer(id, 'barrar')).toMatchObject({ ruleId: 'prod' });
    expect(replies).toEqual([{ answer: 'barrar' }]);
    expect(asks.pending()).toEqual([]);
  });

  it('"liberar nesta sessão" answers the same rule and target at once, only in that session', () => {
    const { asks, replies, reply } = setup();
    const { id } = asks.add(request(), reply());
    asks.answer(id, 'liberar-sessao');
    expect(replies).toEqual([{ answer: 'liberar' }]);
    expect(asks.add(request(), reply())).toEqual({ answered: 'liberar' });
    expect(asks.add(request({ target: 'outro comando prod' }), reply()).id).toBeDefined();
    expect(asks.add(request({ sessionId: 's2' }), reply()).id).toBeDefined();
  });

  it('an irreversible ask is never granted for the session', () => {
    const { asks, reply } = setup();
    const { id } = asks.add(request({ irreversible: true, ruleId: 'main', target: 'main' }), reply());
    asks.answer(id, 'liberar-sessao');
    expect(asks.add(request({ irreversible: true, ruleId: 'main', target: 'main' }), reply()).id).toBeDefined();
  });

  it('an automação ask never takes "liberar nesta sessão": only liberar esta vez or barrar', () => {
    const { asks, replies, reply } = setup();
    const { id } = asks.add(request({ automationId: 'auto-1' }), reply());
    expect(asks.pending()[0].automationId).toBe('auto-1');
    expect(asks.answer(id, 'liberar-sessao')).toBeNull();
    expect(replies).toEqual([]);
    expect(asks.pending()).toHaveLength(1);
    asks.answer(id, 'liberar');
    expect(replies).toEqual([{ answer: 'liberar' }]);
    expect(asks.add(request({ automationId: 'auto-1' }), reply()).id).toBeDefined();
  });

  it('a grant from a chat never answers an automação ask', () => {
    const { asks, reply } = setup();
    asks.answer(asks.add(request(), reply()).id, 'liberar-sessao');
    expect(asks.add(request({ automationId: 'auto-1' }), reply()).id).toBeDefined();
  });

  it('dropSession forgets the grants and ends its pending asks', () => {
    const { asks, reply } = setup();
    const { id } = asks.add(request(), reply());
    asks.answer(id, 'liberar-sessao');
    let ended = false;
    const waiting = reply();
    waiting.end = () => (ended = true);
    asks.add(request({ target: 'x prod' }), waiting);
    asks.dropSession('s1');
    expect(ended).toBe(true);
    expect(asks.pending()).toEqual([]);
    expect(asks.add(request(), reply()).id).toBeDefined();
  });

  it('a guard that hangs up takes its card away', () => {
    const { asks } = setup();
    let onClose;
    const fn = () => {};
    fn.onClose = (callback) => (onClose = callback);
    asks.add(request(), fn);
    onClose();
    expect(asks.pending()).toEqual([]);
  });

  it('only the three choices answer; anything else (prototype keys too) leaves the ask open (#165)', () => {
    const { asks, replies, reply } = setup();
    const { id } = asks.add(request(), reply());
    for (const choice of ['toString', '__proto__', 'constructor', 'LIBERAR', undefined, 1])
      expect(asks.answer(id, choice)).toBeNull();
    expect(replies).toEqual([]);
    expect(asks.pending()).toHaveLength(1);
    expect(GUARD_CHOICES).toEqual(['liberar', 'liberar-sessao', 'barrar']);
    expect(isGuardChoice('toString')).toBe(false);
    expect(isGuardChoice('barrar')).toBe(true);
  });

  it('an ask equal to one already waiting is marked a duplicate, so it is not announced again (#165)', () => {
    const { asks, reply } = setup();
    expect(asks.add(request(), reply()).duplicate).toBe(false);
    expect(asks.add(request(), reply()).duplicate).toBe(true);
    expect(asks.add(request({ target: 'outro prod' }), reply()).duplicate).toBe(false);
  });

  it('"liberar nesta sessão" also frees the equal asks already waiting (#165)', () => {
    const released = [];
    const asks = createGuardAsks({ newId: () => `b${++counter}`, onReleased: (request) => released.push(request) });
    const replies = [];
    const reply = (tag) => {
      const fn = (answer) => replies.push([tag, answer]);
      fn.onClose = () => {};
      return fn;
    };
    const { id } = asks.add(request(), reply('first'));
    asks.add(request(), reply('second'));
    asks.add(request({ target: 'outro prod' }), reply('other'));
    asks.answer(id, 'liberar-sessao');
    expect(replies).toEqual([
      ['first', { answer: 'liberar' }],
      ['second', { answer: 'liberar' }],
    ]);
    expect(released).toHaveLength(1);
    expect(asks.pending().map((ask) => ask.summary)).toEqual(['kubectl --context prod apply']);
  });

  function twins(options = {}) {
    const released = [];
    const promoted = [];
    const closers = [];
    const asks = createGuardAsks({
      newId: () => `t${++counter}`,
      onReleased: (request, choice) => released.push([request.ruleId, choice]),
      onPromote: (ask) => promoted.push(ask.id),
      ...options,
    });
    const replies = [];
    const reply = (tag) => {
      const fn = (answer) => replies.push([tag, answer]);
      fn.onClose = (callback) => closers.push([tag, callback]);
      return fn;
    };
    return { asks, replies, reply, released, promoted, closers };
  }

  for (const [choice, answer] of [
    ['liberar', 'liberar'],
    ['barrar', 'barrar'],
  ]) {
    it(`"${choice}" settles the equal asks waiting behind it the same way (#165)`, () => {
      const { asks, replies, reply, released } = twins();
      const { id } = asks.add(request(), reply('first'));
      asks.add(request(), reply('second'));
      asks.answer(id, choice);
      expect(replies).toEqual([
        ['first', { answer }],
        ['second', { answer }],
      ]);
      expect(released).toEqual([['prod', choice]]);
      expect(asks.pending()).toEqual([]);
    });
  }

  it('an irreversible twin is barred along, but a liberar does not carry over: the twin is announced instead (#165)', () => {
    const { asks, replies, reply, promoted } = twins();
    const main = { irreversible: true, ruleId: 'main', target: 'main' };
    const first = asks.add(request(main), reply('first'));
    const second = asks.add(request(main), reply('second'));
    asks.answer(first.id, 'liberar');
    expect(replies).toEqual([['first', { answer: 'liberar' }]]);
    expect(promoted).toEqual([second.id]);
    asks.add(request(main), reply('third'));
    asks.answer(second.id, 'barrar');
    expect(replies.slice(1)).toEqual([
      ['second', { answer: 'barrar' }],
      ['third', { answer: 'barrar' }],
    ]);
  });

  it('when the announced ask leaves unanswered, its twin is announced in its place (#165)', () => {
    const { asks, reply, promoted, closers } = twins();
    asks.add(request(), reply('first'));
    const second = asks.add(request(), reply('second'));
    closers.find(([tag]) => tag === 'first')[1]();
    expect(promoted).toEqual([second.id]);
    expect(asks.pending().map((ask) => ask.id)).toEqual([second.id]);
  });

  it('releaseAll answers every waiting ask (the app is quitting: the guard falls back to the terminal) (#165)', () => {
    const { asks, replies, reply } = setup();
    asks.add(request(), reply());
    asks.add(request({ sessionId: 's2' }), reply());
    asks.releaseAll('offline');
    expect(replies).toEqual([{ answer: 'offline' }, { answer: 'offline' }]);
    expect(asks.pending()).toEqual([]);
  });

  it('the card summary is the command, or the tool and file, cut at 200', () => {
    const { asks, reply } = setup();
    asks.add(request({ input: { command: 'x'.repeat(300) } }), reply());
    asks.add(request({ tool: 'Edit', input: { file_path: '/repo/config/prod.env' }, target: '/repo/config/prod.env' }), reply());
    const [long, edit] = asks.pending();
    expect(long.summary).toHaveLength(200);
    expect(edit.summary).toBe('Edit /repo/config/prod.env');
  });
});
