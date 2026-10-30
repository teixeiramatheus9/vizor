import { EventEmitter } from 'node:events';

// "entendi: interromper a 22 · cancela em 3s" (#159): in the Maestro, an
// order that changes work is shown as it was understood and waits a few
// seconds, so a misheard one can be cancelled before it acts. One at a time:
// a new order replaces the pending one, which never runs.
// While the user is talking (maybe saying "cancela") the countdown pauses,
// and it comes back with at least resumeMs: the voice takes ~2.4 s to hear
// the end of a sentence, longer than the whole window (review C1).
export function createPendingOrder({
  now = Date.now,
  delayMs = 3000,
  resumeMs = 1500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const orders = new EventEmitter();
  let current = null; // { label, until, run, timer, paused }
  let lastRanAt = -Infinity;

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
    lastRanAt = now();
    orders.emit('ran');
    run();
  };

  orders.pause = () => {
    if (!current || current.paused) return;
    clearTimer(current.timer);
    current.timer = null;
    current.paused = true;
  };

  orders.resume = () => {
    if (!current?.paused) return;
    const left = Math.max(resumeMs, current.until - now());
    current.paused = false;
    current.until = now() + left;
    current.timer = setTimer(() => orders.runNow(), left);
    orders.emit('show', { label: current.label, until: current.until });
  };

  // When the last order ran: a "cancela" right after is too late, not a prompt.
  orders.ranAt = () => lastRanAt;

  orders.pending = () => (current ? { label: current.label, until: current.until } : null);

  return orders;
}
