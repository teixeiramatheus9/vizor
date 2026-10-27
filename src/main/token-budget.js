import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Tracks how many tokens the manager's AI calls spent TODAY (local time),
// persisted so restarts don't reset the meter. Emits 'spent' (the new total)
// after each record, so a view can follow the meter without polling.
export class TokenBudget extends EventEmitter {
  constructor({ file, now = () => new Date() }) {
    super();
    this.file = file;
    this.now = now;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.date = raw.date;
      this.used = Number(raw.used) || 0;
    } catch {
      this.date = this.today();
      this.used = 0;
    }
    this.rollover();
  }

  today() {
    const date = this.now();
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  rollover() {
    if (this.date === this.today()) return;
    this.date = this.today();
    this.used = 0;
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ date: this.date, used: this.used }));
    } catch {
      // metering must never break the app
    }
  }

  add(tokens) {
    this.rollover();
    const amount = Number(tokens);
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.used += Math.round(amount);
    this.save();
    this.emit('spent', this.used);
  }

  usedToday() {
    this.rollover();
    return this.used;
  }

  // budget ≤ 0 means "permanent economy mode" by user choice.
  isExceeded(budgetDaily) {
    return budgetDaily <= 0 || this.usedToday() >= budgetDaily;
  }
}
