import { describe, expect, it } from 'vitest';
import { createPlanActions } from '../src/main/work/plans.js';

function setup({ plan = { steps: [{ text: 'a', done: false }], approved: false }, result = 'sent', refusePr = () => null, refuseApprove = () => null } = {}) {
  const approved = [];
  const sent = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const actions = createPlanActions({
    planOf: () => plan,
    approve: (sessionId) => approved.push(sessionId),
    refusePr,
    refuseApprove,
    deliver: async (sessionId, text) => {
      sent.push([sessionId, text]);
      if (result === 'slow') return gate.then(() => 'sent');
      return result;
    },
  });
  return { actions, approved, sent, release };
}

describe('the plan card actions', () => {
  it('I2: approval counts only once the ok reached the chat', async () => {
    const ok = setup();
    expect(await ok.actions.run('s1', 'approve')).toBe('sent');
    expect(ok.approved).toEqual(['s1']);
    for (const result of ['timeout', 'failed']) {
      const late = setup({ result });
      expect(await late.actions.run('s1', 'approve')).toBe(result);
      expect(late.approved).toEqual([]);
    }
  });

  it('no plan, nothing to approve', async () => {
    const { actions, sent } = setup({ plan: null });
    expect(await actions.run('s1', 'approve')).toBe('no-plan');
    expect(sent).toEqual([]);
  });

  it('a second click while the first still waits sends nothing more', async () => {
    const { actions, sent, release } = setup({ result: 'slow' });
    const first = actions.run('s1', 'pr');
    expect(await actions.run('s1', 'pr')).toBe('busy');
    release();
    expect(await first).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(await actions.run('s1', 'pr')).toBe('sent');
  });

  it('an unknown action or session is refused', async () => {
    const { actions } = setup();
    expect(await actions.run(null, 'approve')).toBe('failed');
    expect(await actions.run('s1', 'merge')).toBe('failed');
  });

  it('the PR is refused, with the reason, while the task is not ready for it', async () => {
    const { actions, sent } = setup({ refusePr: (sessionId) => (sessionId === 's1' ? 'o teste do contrato mudou' : null) });
    expect(await actions.run('s1', 'pr')).toEqual({ error: 'o teste do contrato mudou' });
    expect(sent).toEqual([]);
    expect(await actions.run('s2', 'pr')).toBe('sent');
    expect(await actions.run('s1', 'approve')).toBe('sent');
  });

  it('the old ok is refused, with the reason, on a task with a contract', async () => {
    const { actions, sent, approved } = setup({ refuseApprove: () => 'esta tarefa tem contrato: aprove o contrato no card' });
    expect(await actions.run('s1', 'approve')).toEqual({ error: 'esta tarefa tem contrato: aprove o contrato no card' });
    expect(sent).toEqual([]);
    expect(approved).toEqual([]);
  });
});
