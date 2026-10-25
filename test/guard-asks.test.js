import { describe, it, expect } from 'vitest';
import { createGuardAsks } from '../src/main/guard-asks.js';

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

  it('the card summary is the command, or the tool and file, cut at 200', () => {
    const { asks, reply } = setup();
    asks.add(request({ input: { command: 'x'.repeat(300) } }), reply());
    asks.add(request({ tool: 'Edit', input: { file_path: '/repo/config/prod.env' }, target: '/repo/config/prod.env' }), reply());
    const [long, edit] = asks.pending();
    expect(long.summary).toHaveLength(200);
    expect(edit.summary).toBe('Edit /repo/config/prod.env');
  });
});
