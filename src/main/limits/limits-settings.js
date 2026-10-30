// Pure helpers for the "limites" settings section.
import fs from 'node:fs';
import path from 'node:path';

// Projects whose own .claude/settings(.local).json sets a statusLine: Claude
// Code prefers it over the user's, so the tap never sees those chats.
// Read only when the section opens, never on a hot path.
export function projectStatusLineOverrides(projects, { readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const out = [];
  for (const root of Array.isArray(projects) ? projects : []) {
    if (typeof root !== 'string' || !root) continue;
    const own = ['settings.json', 'settings.local.json'].some((name) => {
      try {
        const parsed = JSON.parse(readFile(path.join(root, '.claude', name)));
        return Boolean(parsed && typeof parsed === 'object' && parsed.statusLine);
      } catch {
        return false;
      }
    });
    if (own) out.push({ root, name: path.basename(root) || root });
  }
  return out;
}

// What the status line row says: connected, swapped for another, or still
// waiting for the first chat to report.
export function tapStatusText({ tap, seenAt } = {}) {
  if (tap?.replaced) return { kind: 'replaced', text: 'trocada por outra — reconectar?' };
  if (tap?.installed) return seenAt ? { kind: 'connected', text: 'conectada' } : { kind: 'waiting', text: 'sem chats ainda' };
  return { kind: 'off', text: 'desligada' };
}
