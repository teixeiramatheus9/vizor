// Spotting file changes that no Edit/Write hook explains — a `sed -i` through
// Bash, a formatter, a codegen. Pure: the poller in command-watcher.js feeds
// it git status output and file signatures.

export const POLL_MS = 1500;
// A mass rewrite (lockfile churn, a codegen) is not a diff anyone reads line
// by line: past this many dirty paths a cycle is skipped.
export const MAX_DIRTY_PATHS = 200;
export const EXPLAIN_WINDOW_MS = 5000;

// `git status --porcelain=v1 -z`: "XY path\0"; a rename or copy carries the
// original path as the next record, which is skipped.
export function parseGitStatusZ(output) {
  const records = String(output ?? '').split('\0');
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (status.includes('R') || status.includes('C')) index += 1;
    if (!paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

export function changedPaths(prevSigs, nextSigs) {
  const changed = [];
  for (const filePath of new Set([...prevSigs.keys(), ...nextSigs.keys()]))
    if (prevSigs.get(filePath) !== nextSigs.get(filePath)) changed.push(filePath);
  return changed;
}

// A change only becomes a command edit after a full poll cycle unexplained:
// the PostToolUse of a real Edit is async and can land after the poll that saw
// the file move.
export function settleCandidates({ pending, changed, explained, now }) {
  const next = new Map();
  const emit = [];
  for (const [filePath, detectedAt] of pending) {
    if (explained(filePath, detectedAt)) continue;
    emit.push(filePath);
  }
  for (const filePath of changed) {
    if (emit.includes(filePath) || next.has(filePath)) continue;
    if (!pending.has(filePath)) next.set(filePath, now);
  }
  return { emit, pending: next };
}
