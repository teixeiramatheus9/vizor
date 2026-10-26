import { createHash } from 'node:crypto';

// Pure parsing of git's diff output. The service runs git (with
// core.quotePath=false) and feeds the text in; nothing here touches IO.

const BINARY_SNIFF_CHARS = 8000;

// Refs to try as the branch's base, best first. Falsy entries and repeats drop.
export function baseCandidates({ upstream, config } = {}) {
  const list = [config?.base, upstream, 'origin/main', 'main', 'origin/master', 'master'];
  return [...new Set(list.filter(Boolean))];
}

// `git diff --numstat -z`: "added\tremoved\tpath\0", or for a rename
// "added\tremoved\t\0old\0new\0". Binary files report "-" for the counts.
export function parseNumstatZ(text) {
  const parts = text.split('\0');
  const out = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) { i++; continue; }
    const binary = m[1] === '-';
    let path = m[3];
    let oldPath = null;
    if (path === '') {
      oldPath = parts[i + 1] ?? null;
      path = parts[i + 2] ?? '';
      i += 3;
    } else {
      i += 1;
    }
    out.push({
      path,
      oldPath,
      added: binary ? null : Number(m[1]),
      removed: binary ? null : Number(m[2]),
      binary,
    });
  }
  return out;
}

// Identity of a hunk that survives line shifts: path + the changed text, no
// line numbers, so the same edit keeps its id when code above it moves.
export function hunkId(path, lines) {
  const body = lines.map((l) => l.kind + l.text).join('\n');
  return createHash('sha1').update(path + '\0' + body).digest('hex').slice(0, 16);
}

// "diff --git a/X b/Y" with no ---/+++ (binary, mode-only). X and Y may hold
// spaces, so use the symmetric split first and fall back to the last " b/".
function pathFromGitHeader(rest) {
  const half = (rest.length - 3) / 2;
  if (Number.isInteger(half) && rest.slice(0, 2) === 'a/' && rest.slice(half + 1, half + 4) === ' b/'
      && rest.slice(2, half + 1) === rest.slice(half + 4)) {
    return { path: rest.slice(half + 4), oldPath: rest.slice(2, half + 1) };
  }
  const at = rest.lastIndexOf(' b/');
  if (at < 0) return { path: rest, oldPath: null };
  return { path: rest.slice(at + 3), oldPath: rest.slice(0, at).replace(/^a\//, '') };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text) {
  const rows = text.split('\n');
  const files = [];
  let file = null;
  let i = 0;

  const finish = () => {
    if (!file) return;
    files.push(file);
    file = null;
  };

  while (i < rows.length) {
    const row = rows[i];
    if (row.startsWith('diff --git ')) {
      finish();
      const { path } = pathFromGitHeader(row.slice('diff --git '.length));
      file = { path, oldPath: null, status: 'modified', binary: false, hunks: [] };
      i++;
      continue;
    }
    if (!file) { i++; continue; }

    if (row.startsWith('new file mode')) file.status = 'added';
    else if (row.startsWith('deleted file mode')) file.status = 'deleted';
    else if (row.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = row.slice(12); }
    else if (row.startsWith('rename to ')) file.path = row.slice(10);
    else if (row.startsWith('Binary files ') || row.startsWith('GIT binary patch')) file.binary = true;
    else if (row.startsWith('+++ ') && row !== '+++ /dev/null') file.path = row.slice(4).replace(/^b\//, '');
    else if (row.startsWith('--- a/') && file.status === 'deleted') file.path = row.slice(6);

    const m = HUNK_RE.exec(row);
    if (!m) { i++; continue; }

    const hunk = {
      header: row,
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      lines: [],
    };
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    i++;
    // Walk by the declared counts so a content line that looks like a header
    // can never be mistaken for one.
    while (i < rows.length && (oldLeft > 0 || newLeft > 0 || rows[i].startsWith('\\'))) {
      const r = rows[i];
      if (r.startsWith('\\')) { i++; continue; }
      const kind = r === '' ? ' ' : r[0];
      const body = r.slice(1);
      if (kind === '+') { hunk.lines.push({ kind, text: body, oldNo: null, newNo: newNo++ }); newLeft--; }
      else if (kind === '-') { hunk.lines.push({ kind, text: body, oldNo: oldNo++, newNo: null }); oldLeft--; }
      else if (kind === ' ') { hunk.lines.push({ kind, text: body, oldNo: oldNo++, newNo: newNo++ }); oldLeft--; newLeft--; }
      else break;
      i++;
    }
    file.hunks.push(hunk);
  }
  finish();

  for (const f of files) {
    for (const h of f.hunks) h.id = hunkId(f.path, h.lines);
  }
  return files;
}

// A hunk is "committed" when it is in the base diff but gone from HEAD to the
// worktree, i.e. the working tree no longer differs from HEAD there.
export function markCommitted(baseFiles, headToWorktreeFiles) {
  const open = new Set();
  for (const f of headToWorktreeFiles) for (const h of f.hunks) open.add(h.id);
  return baseFiles.map((f) => ({
    ...f,
    hunks: f.hunks.map((h) => ({ ...h, committed: !open.has(h.id) })),
  }));
}

// Untracked files are invisible to git diff: show each as one all-added hunk.
export function untrackedAsFiles(paths, readText) {
  return paths.map((path) => {
    const text = readText(path) ?? '';
    const file = { path, oldPath: null, status: 'added', binary: false, hunks: [] };
    if (text.slice(0, BINARY_SNIFF_CHARS).includes('\0')) {
      file.binary = true;
      return file;
    }
    if (text === '') return file;
    const rows = text.split('\n');
    if (rows[rows.length - 1] === '') rows.pop();
    const lines = rows.map((t, n) => ({ kind: '+', text: t, oldNo: null, newNo: n + 1 }));
    file.hunks.push({
      id: hunkId(path, lines),
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines,
    });
    return file;
  });
}
