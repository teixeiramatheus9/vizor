import { structuredPatch } from 'diff';

// Past this size a file gets a card without a diff: the live view is for
// reading what the AI wrote, and nobody reads a 2 MB diff line by line.
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_CHARS = 8000;

export function diffability(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES) return 'too-large';
  if (text.slice(0, BINARY_SNIFF_CHARS).includes('\u0000')) return 'binary';
  return 'ok';
}

// Myers is O(N·D) and runs on the main process: a full rewrite of a 20k-line
// file took 50 s, freezing the bubble and every session. Past this budget the
// diff gives up and the edit is shown without one.
const DIFF_TIMEOUT_MS = 250;

// Context 0: the hunks are exactly the changed lines, so the counts and the
// ranges the live view highlights mean the same thing. Trailing CRs are
// ignored so a LF baseline (the git index) against a CRLF checkout only shows
// what really changed. Null when the diff gave up.
export function diffHunks(before, after) {
  const patch = structuredPatch('before', 'after', before, after, '', '', {
    context: 0,
    stripTrailingCr: true,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!patch) return null;
  let added = 0;
  let removed = 0;
  const hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => {
    // jsdiff's "\ No newline at end of file" markers are not lines of the file.
    const changed = lines.filter((line) => line[0] === '+' || line[0] === '-');
    for (const line of changed) {
      if (line[0] === '+') added += 1;
      else removed += 1;
    }
    return { oldStart, oldLines, newStart, newLines, lines: changed };
  });
  return { hunks, added, removed };
}
