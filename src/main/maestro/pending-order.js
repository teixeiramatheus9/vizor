import { EventEmitter } from 'node:events';

// "entendi: interromper a 22 · cancela em 3s" (#159): in the Maestro, an
// order that changes work is shown as it was understood and waits a few
// seconds, so a misheard one can be cancelled before it acts. One at a time:
// a new order replaces the pending one, which never runs.
export function createPendingOrder({ now = Date.now, delayMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const orders = new EventEmitter();
  let current = null; // { label, until, run, timer }

  const clear = (reason) => {
    if (!current) return null;
    const { run, timer } = current;
    clearTimer(timer);
    current = null;
    orders.emit('clear', { reason });
    return run;
  };

  orders.hold = (order, run) => {
    clear('replaced');
    const until = now() + delayMs;
    current = { label: order.label, until, run, timer: setTimer(() => orders.runNow(), delayMs) };
    orders.emit('show', { label: order.label, until });
  };

  orders.cancel = () => {
    clear('cancelled');
  };

  orders.runNow = () => {
    const run = clear('ran');
    if (!run) return;
    orders.emit('ran');
    run();
  };

  orders.pending = () => (current ? { label: current.label, until: current.until } : null);

  return orders;
}
