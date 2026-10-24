// The text a 💬 comment sends to Claude (#95): where the change is, which
// edit it was, then the comment as typed. The lines are the edit's own hunk
// as it landed — the coordinates Claude knows from its own edit.

export const MAX_COMMENT_CHARS = 4000;

export function validateComment(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Escreve alguma coisa' };
  if (trimmed.length > MAX_COMMENT_CHARS) return { ok: false, error: 'Comentário longo demais (máx. 4000)' };
  return { ok: true, text: trimmed };
}

function where(hunks) {
  const touched = (hunks ?? []).filter((hunk) => hunk.newLines >= 1);
  if (touched.length) {
    const from = touched[0].newStart;
    const last = touched.at(-1);
    const to = last.newStart + last.newLines - 1;
    return from === to ? `, linha ${from}` : `, linhas ${from}–${to}`;
  }
  if (hunks?.length) return `, perto da linha ${hunks[0].oldStart}`;
  return '';
}

export function commentHeader(edit) {
  const which = edit.status === 'by-command' ? `mudança por comando #${edit.seq}` : `sua edição #${edit.seq}`;
  return `Sobre ${edit.relPath}${where(edit.hunks)} (${which}):`;
}

export function buildCommentMessage(edit, text) {
  return `${commentHeader(edit)}\n${text}`;
}

// Claude Code takes a bracketed paste as one message, newlines and all; a
// bare newline typed into it would submit half the comment.
export function bracketedPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

export function flattenForTyping(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}
