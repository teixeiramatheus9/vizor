// What the renderer sends to the review IPC is untrusted: paths must stay
// inside the worktree and prefs are limited to the keys the store keeps. Pure.
export function safeRelPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return null;
  if (value.split(/[\\/]/).includes('..')) return null;
  return value;
}

export function sanitizePrefs(set) {
  if (!set || typeof set !== 'object') return {};
  const out = {};
  if (set.tab === null || (typeof set.tab === 'string' && set.tab.length <= 40)) out.tab = set.tab;
  if (set.drawerHeight === null || (Number.isFinite(set.drawerHeight) && set.drawerHeight >= 0 && set.drawerHeight <= 10000)) out.drawerHeight = set.drawerHeight;
  if (set.drawerOpen === null || typeof set.drawerOpen === 'boolean') out.drawerOpen = set.drawerOpen;
  if (Array.isArray(set.openFiles)) out.openFiles = set.openFiles.map(safeRelPath).filter(Boolean).slice(0, 50);
  return out;
}
