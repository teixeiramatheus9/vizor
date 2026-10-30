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
  if (set.innerTab === null || (typeof set.innerTab === 'string' && set.innerTab.length <= 40)) out.innerTab = set.innerTab;
  if (set.filter === null || (typeof set.filter === 'string' && set.filter.length <= 200 && !set.filter.includes('\0'))) out.filter = set.filter;
  // Where the reader was in the file: its path and the hunk nearest the top.
  if (set.scrollAnchor === null) out.scrollAnchor = null;
  else if (set.scrollAnchor && typeof set.scrollAnchor === 'object') {
    const path = safeRelPath(set.scrollAnchor.path);
    const hunkId = set.scrollAnchor.hunkId;
    if (path && path.length <= 1000 && (hunkId === null || (typeof hunkId === 'string' && hunkId.length > 0 && hunkId.length <= 64))) out.scrollAnchor = { path, hunkId };
  }
  if (Array.isArray(set.openFiles)) out.openFiles = set.openFiles.map(safeRelPath).filter(Boolean).slice(0, 50);
  return out;
}
