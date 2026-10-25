import { describe, expect, it } from 'vitest';
import { createPendingOrder } from '../src/main/maestro/pending-order.js';

// A fake clock and timer: fire() runs the scheduled callback.
function setup() {
  let time = 1000;
  let timer = null;
  const order = createPendingOrder({
    now: () => time,
    setTimer: (callback, ms) => (timer = { callback, ms }),
    clearTimer: (handle) => {
      if (handle === timer) timer = null;
    },
  });
  const events = [];
  order.on('show', (info) => events.push(['show', info]));
  order.on('clear', (info) => events.push(['clear', info.reason]));
  return { order, events, fire: () => timer?.callback(), timer: () => timer, advance: (ms) => (time += ms) };
}

describe('a Maestro order, held "entendi: …" before it acts', () => {
  it('holds the order for 3 s, then runs it once', () => {
    const { order, fire, timer } = setup();
    let runs = 0;
    order.hold({ label: 'interromper a 22' }, () => runs++);
    expect(timer().ms).toBe(3000);
    expect(runs).toBe(0);
    fire();
    expect(runs).toBe(1);
    expect(order.pending()).toBeNull();
    fire();
    expect(runs).toBe(1);
  });

  it('cancel within the window: never runs', () => {
    const { order, fire } = setup();
    let runs = 0;
    order.hold({ label: 'x' }, () => runs++);
    order.cancel();
    fire();
    expect(runs).toBe(0);
    expect(order.pending()).toBeNull();
  });

  it('runNow skips the wait and runs once', () => {
    const { order, fire } = setup();
    let runs = 0;
    order.hold({ label: 'x' }, () => runs++);
    order.runNow();
    fire();
    order.runNow();
    expect(runs).toBe(1);
  });

  it('a new order replaces the pending one, which never runs', () => {
    const { order, fire } = setup();
    const ran = [];
    order.hold({ label: 'first' }, () => ran.push('first'));
    order.hold({ label: 'second' }, () => ran.push('second'));
    fire();
    expect(ran).toEqual(['second']);
  });

  it('emits show with the label and the deadline, and clear with the reason', () => {
    const { order, events, fire } = setup();
    order.hold({ label: 'a' }, () => {});
    expect(order.pending()).toEqual({ label: 'a', until: 4000 });
    order.hold({ label: 'b' }, () => {});
    order.cancel();
    order.hold({ label: 'c' }, () => {});
    fire();
    expect(events).toEqual([
      ['show', { label: 'a', until: 4000 }],
      ['clear', 'replaced'],
      ['show', { label: 'b', until: 4000 }],
      ['clear', 'cancelled'],
      ['show', { label: 'c', until: 4000 }],
      ['clear', 'ran'],
    ]);
  });
});
