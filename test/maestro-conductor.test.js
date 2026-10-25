import { describe, expect, it } from 'vitest';
import { createConductor, MAX_FIX_ATTEMPTS, parseSteps, promptFor } from '../src/main/maestro/conductor.js';

const testsAndPr = { label: 'rodar os testes e abrir a PR', steps: parseSteps('manda rodar os testes e abrir a PR') };

describe('the conducting gerente', () => {
  it('parseSteps understands tests, PR and review, else keeps the text', () => {
    expect(parseSteps('manda rodar os testes e abrir a PR')).toEqual({ tests: true, pr: true, review: false, free: null });
    expect(parseSteps('abre a pull request')).toEqual({ tests: false, pr: true, review: false, free: null });
    expect(parseSteps('pede uma revisão')).toEqual({ tests: false, pr: false, review: true, free: null });
    expect(parseSteps('atualiza o README')).toEqual({ tests: false, pr: false, review: false, free: 'atualiza o README' });
    expect(promptFor(parseSteps('roda os testes e abre a PR'), 0)).toContain('gh pr create');
    expect(promptFor(parseSteps('roda os testes'), 1)).toMatch(/^Os testes falharam\. Corrija e rode de novo/);
  });

  it('the order goes out when the turn ends, and is done when the tests pass', () => {
    const conductor = createConductor();
    expect(conductor.order('s22', testsAndPr)).toEqual({ replaced: false });
    expect(conductor.ordersOf('s22')).toMatchObject({ label: 'rodar os testes e abrir a PR', attempt: 0, waiting: 'turn' });
    const sent = conductor.turnEnded('s22', { tests: null });
    expect(sent).toEqual([{ type: 'prompt', sessionId: 's22', text: promptFor(testsAndPr.steps, 0) }]);
    conductor.delivered('s22', true);
    expect(conductor.ordersOf('s22').waiting).toBe('result');
    const done = conductor.turnEnded('s22', { tests: 'passed' });
    expect(done).toEqual([{ type: 'done', sessionId: 's22', text: expect.stringContaining('rodar os testes e abrir a PR') }]);
    expect(conductor.ordersOf('s22')).toBeNull();
  });

  it('failed tests: two fix rounds, then it calls you', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    conductor.turnEnded('s22', { tests: null });
    conductor.delivered('s22', true);
    expect(conductor.turnEnded('s22', { tests: 'failed' })).toEqual([{ type: 'prompt', sessionId: 's22', text: promptFor(testsAndPr.steps, 1) }]);
    conductor.delivered('s22', true);
    expect(conductor.turnEnded('s22', { tests: 'failed' })).toEqual([{ type: 'prompt', sessionId: 's22', text: promptFor(testsAndPr.steps, 2) }]);
    conductor.delivered('s22', true);
    const call = conductor.turnEnded('s22', { tests: 'failed' });
    expect(call).toEqual([{ type: 'call-user', sessionId: 's22', text: expect.stringContaining(`${MAX_FIX_ATTEMPTS} tentativas`) }]);
    expect(conductor.ordersOf('s22')).toBeNull();
    expect(MAX_FIX_ATTEMPTS).toBe(2);
  });

  it('a turn that ran no tests asks once more, then calls you', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    conductor.turnEnded('s22', { tests: null });
    conductor.delivered('s22', true);
    const again = conductor.turnEnded('s22', { tests: null });
    // The nudge carries the whole order (review I2: "abrir a PR" was dropped).
    expect(again).toEqual([{ type: 'prompt', sessionId: 's22', text: `Você não rodou os testes. ${promptFor(testsAndPr.steps, 0)}` }]);
    conductor.delivered('s22', true);
    expect(conductor.turnEnded('s22', { tests: null })).toEqual([{ type: 'call-user', sessionId: 's22', text: expect.stringContaining('não rodou os testes') }]);
    // An order without tests is done at the next end of turn.
    conductor.order('s9', { label: 'atualizar o README', steps: parseSteps('atualiza o README') });
    conductor.turnEnded('s9', { tests: null });
    conductor.delivered('s9', true);
    expect(conductor.turnEnded('s9', { tests: null })[0].type).toBe('done');
  });

  it('a new order for the same músico replaces the old one', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    expect(conductor.order('s22', { label: 'abrir a PR', steps: parseSteps('abre a PR') })).toEqual({ replaced: true });
    expect(conductor.ordersOf('s22').label).toBe('abrir a PR');
    expect(conductor.list()).toHaveLength(1);
  });

  it('the músico closing its tab drops the order and says so', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    expect(conductor.sessionGone('s22')).toEqual([{ type: 'call-user', sessionId: 's22', text: expect.stringContaining('fechou antes') }]);
    expect(conductor.ordersOf('s22')).toBeNull();
    expect(conductor.sessionGone('nobody')).toEqual([]);
  });
});

describe('the conductor, review fixes', () => {
  it('C1: a prompt that never arrived does not move the order on, and says so', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    conductor.turnEnded('s22', { tests: null });
    expect(conductor.ordersOf('s22').waiting).toBe('sending');
    expect(conductor.delivered('s22', false)).toEqual([{ type: 'call-user', sessionId: 's22', text: expect.stringContaining('não consegui mandar') }]);
    expect(conductor.ordersOf('s22').waiting).toBe('turn');
    // The next end of turn tries again; this time it arrives.
    conductor.turnEnded('s22', { tests: null });
    expect(conductor.delivered('s22', true)).toEqual([]);
    expect(conductor.ordersOf('s22').waiting).toBe('result');
  });

  it('C1: an end of turn while the prompt is still on its way is not its result', () => {
    const conductor = createConductor();
    conductor.order('s22', testsAndPr);
    conductor.turnEnded('s22', { tests: null });
    expect(conductor.turnEnded('s22', { tests: 'passed' })).toEqual([]);
    expect(conductor.ordersOf('s22')).not.toBeNull();
  });

  it('M2: clear drops every order', () => {
    const conductor = createConductor();
    conductor.order('a', testsAndPr);
    conductor.order('b', testsAndPr);
    conductor.clear();
    expect(conductor.list()).toEqual([]);
  });
});
