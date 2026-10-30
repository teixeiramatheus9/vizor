// The review screen's composer: what the dev types about a hunk, a file or a
// graph node becomes one message for the chat, through the same channel as
// the 💬 comments. Pure.
import { validateComment } from '../comment-message.js';

export const EXPLAIN_TEXT = 'Explique esse trecho e por que foi feito assim.';

export const rejectNotice = (path, newStart) =>
  `Desfiz o trecho de ${path} perto da linha ${newStart}, na revisão. Não refaça sem me perguntar.`;

const lines = (from, to) => (to > from ? `linhas ${from}–${to}` : `linha ${from}`);

function header(context) {
  if (!context) return null;
  if (context.kind === 'hunk') {
    // A pure deletion has no new lines: point at where it was.
    if (!(context.newLines >= 1)) return `Sobre ${context.path}, perto da linha ${context.newStart} (trecho da revisão):`;
    return `Sobre ${context.path}, ${lines(context.newStart, context.newStart + context.newLines - 1)} (trecho da revisão):`;
  }
  if (context.kind === 'file') return `Sobre ${context.path} (arquivo da revisão):`;
  if (context.kind === 'node') {
    const at = Number.isInteger(context.startLine)
      ? `, ${lines(context.startLine, Number.isInteger(context.endLine) ? context.endLine : context.startLine)}`
      : '';
    return `Sobre ${context.label} (${context.path}${at}, grafo da revisão):`;
  }
  return null;
}

// → { ok: true, text, message } | { ok: false, error }
export function composeMessage(context, text) {
  const valid = validateComment(text);
  if (!valid.ok) return valid;
  const head = header(context);
  return { ok: true, text: valid.text, message: head ? `${head}\n${valid.text}` : valid.text };
}
