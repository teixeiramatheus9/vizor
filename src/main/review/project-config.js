// Optional per-project settings from <worktree>/.vizor/projeto.json:
// { base?, test?, tsc? }. Anything unusable is dropped, never thrown.
export function parseProjectConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of ['base', 'test']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) out[key] = raw[key].trim();
  }
  if (typeof raw.tsc === 'boolean') out.tsc = raw.tsc;
  return out;
}
