// Rebuilds what a file held before an edit, from the file as it is now and
// the tool input that changed it. Derived from the disk, so it can never
// pin someone else's change on the AI — but it only answers when the answer
// is unambiguous; anything else returns null and the caller falls back.

// Overlapping matches count too: "aa" sits twice in "aaa", and either could
// be the one the edit wrote.
function countOccurrences(text, needle) {
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1))
    count += 1;
  return count;
}

// Claude Code matches tool strings on LF-normalized text and writes the
// file's own endings back, so in a CRLF file the strings need CRLF too.
function toFileEndings(text, after) {
  if (!after.includes('\r\n') || text.includes('\r')) return text;
  return text.replace(/\n/g, '\r\n');
}

function reverseOne(after, { old_string: oldString, new_string: newString, replace_all: replaceAll }) {
  // A truncated string arrives as { truncated: n } — nothing to match against.
  if (typeof after !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string')
    return null;
  // A deletion leaves nothing in the file to anchor the old text to.
  if (newString === '') return null;
  // replace_all: occurrences of new_string that were already in the file
  // look exactly like the ones the edit wrote, so turning them all back would
  // invent a "before" that never existed.
  if (replaceAll) return null;
  const needle = toFileEndings(newString, after);
  if (countOccurrences(after, needle) !== 1) return null;
  return after.replace(needle, () => toFileEndings(oldString, after));
}

export function reverseEdit({ toolName, toolInput, after }) {
  if (toolName === 'Edit') return reverseOne(after, toolInput ?? {});
  if (toolName === 'MultiEdit') {
    const edits = toolInput?.edits;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    let content = after;
    for (const edit of [...edits].reverse()) {
      content = reverseOne(content, edit ?? {});
      if (content === null) return null;
    }
    return content;
  }
  return null;
}
