// The day's spend across every automação (local calendar day), persisted so a
// restart does not hand out a fresh cap. IO injected; a corrupt file reads as 0.
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createDailyBudget({ file, readFile, writeFile, now = () => new Date(), capUsd: initialCap = 5 }) {
  let capUsd = initialCap;
  let day = null;
  let total = 0;
  const load = () => {
    try {
      const raw = JSON.parse(readFile(file));
      if (typeof raw?.day === 'string' && Number.isFinite(raw.spent) && raw.spent >= 0) { day = raw.day; total = raw.spent; return; }
    } catch { /* first run or unreadable: start the day at 0 */ }
    day = dayKey(now());
    total = 0;
  };
  const save = () => {
    try { writeFile(file, JSON.stringify({ day, spent: total })); } catch { /* a failed save must not stop a run */ }
  };
  // Flip to a fresh day when the local date changed.
  const roll = () => {
    const today = dayKey(now());
    if (day !== today) { day = today; total = 0; save(); }
  };
  load();
  roll();
  return {
    spent() { roll(); return total; },
    add(usd) {
      roll();
      if (Number.isFinite(usd) && usd > 0) { total = Math.round((total + usd) * 1e6) / 1e6; save(); }
      return total;
    },
    // Whether a run capped at capOfRun still fits in today's cap.
    allows(capOfRun) { roll(); return total + capOfRun <= capUsd + 1e-9; },
    get capUsd() { return capUsd; },
    setCap(usd) { if (Number.isFinite(usd) && usd > 0) capUsd = usd; },
  };
}
