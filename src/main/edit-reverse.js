// Rebuilds what a file held before an edit, from the file as it is now and
// the tool input that changed it. Derived from the disk, so it can never
// pin someone else's change on the AI — but it only answers when the answer
// is unambiguous; anything else returns null and the caller falls back.

function countOccurrences(text, needle) {
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length))
    count += 1;
  return count;
}

function reverseOne(after, { old_string: oldString, new_string: newString, replace_all: replaceAll }) {
  // A truncated string arrives as { truncated: n } — nothing to match against.
  if (typeof after !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string')
    return null;
  // A deletion leaves nothing in the file to anchor the old text to.
  if (newString === '') return null;
  const occurrences = countOccurrences(after, newString);
  if (replaceAll ? occurrences === 0 : occurrences !== 1) return null;
  return after.split(newString).join(oldString);
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
