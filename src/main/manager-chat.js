import { runClaude } from './claude-cli.js';

const HISTORY_LIMIT = 6;
const HISTORY_ENTRY_CHARS = 300;
const EXCERPT_CHARS = 1200;

const truncate = (text, max) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const STATUS_LABEL = {
  working: 'trabalhando',
  done: 'terminou',
  waiting: 'esperando o usuário',
};

// Local, zero-token context: one compact line per session.
export function buildSessionsDigest(sessions, now = Date.now()) {
  if (!sessions.length) return 'Nenhuma sessão registrada no momento.';
  return sessions
    .map((session) => {
      const theme = session.title ?? session.promptPreview ?? session.displayName ?? session.projectName;
      const ageMinutes = Math.max(0, Math.round((now - session.updatedAt) / 60000));
      const message = session.managerMessage ? ` — último recado: ${truncate(session.managerMessage, 120)}` : '';
      const folder =
        session.displayName && session.displayName !== session.projectName
          ? `${session.displayName}, pasta ${session.projectName}`
          : `pasta ${session.projectName}`;
      return `- [${STATUS_LABEL[session.status] ?? session.status}] "${theme}" (${folder}, há ${ageMinutes}min)${message}`;
    })
    .join('\n');
}

// Only pay for a transcript excerpt when the user actually names a chat.
export function findMentionedSession(sessions, userMessage) {
  const messageLower = String(userMessage ?? '').toLowerCase();
  return (
    sessions.find((session) => {
      const candidates = [session.projectName, session.displayName, session.title, session.promptPreview]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return candidates.some((candidate) => candidate.length >= 4 && messageLower.includes(candidate));
    }) ?? null
  );
}

// An English voice (#161) hears the gerente in English; the user still speaks
// Portuguese. The offer to resume a task has a fixed shape the voice detects.
const LANGUAGE_RULE = {
  pt: 'Responda em pt-BR informal, DIRETO e CURTO (até 3 frases, a menos que ele peça detalhe).',
  en: 'Reply in casual American English, SHORT and DIRECT (up to 3 sentences unless asked for detail), even though the user writes in Portuguese. Your reply is spoken by an English voice.',
};

// The gerente only reads the GitHub; the músicos (Claude chats) act. An
// action is offered in one fixed question, which the voice turns into a
// confirmable order (#159).
const ACTIONS_RULE = {
  pt: 'Você só lê o GitHub; quem age são os músicos (os chats do Claude). Pra propor uma ação, termine com UMA destas perguntas, exatamente: "Quer que eu puxe a issue N?" (um músico começa a issue), "Quer que eu peça revisão da PR N?" (um músico revisa a PR) ou "Quer que eu retome a N?" (volta pro chat da tarefa). Nunca ofereça atribuir (assign) uma issue: pra começar a trabalhar nela, a ação é puxar.',
  en: 'You only read the GitHub; the músicos (the Claude chats) act. To offer an action, end with ONE of these questions, exactly: "Want me to pick up issue N?", "Want me to get PR N reviewed?" or "Want me to resume task N?". Never offer to assign an issue: to start working on one, the action is picking it up.',
};

export function buildChatPrompt({ digest, history = [], userMessage, transcriptExcerpt = null, lang = 'pt' }) {
  const historyText = history
    .slice(-HISTORY_LIMIT)
    .map((entry) => `${entry.role === 'user' ? 'Usuário' : 'Gerente'}: ${truncate(entry.text, HISTORY_ENTRY_CHARS)}`)
    .join('\n');
  return [
    'Você é o "Gerente", assistente descontraído que acompanha as sessões do Claude Code do usuário.',
    LANGUAGE_RULE[lang] ?? LANGUAGE_RULE.pt,
    ACTIONS_RULE[lang] ?? ACTIONS_RULE.pt,
    'Nada de markdown. Você não executa nada — só informa e orienta com base no estado abaixo.',
    '',
    'Estado atual das sessões:',
    digest,
    transcriptExcerpt
      ? `\nÚltima resposta do assistente na sessão citada (truncada):\n"""\n${truncate(transcriptExcerpt, EXCERPT_CHARS)}\n"""`
      : '',
    historyText ? `\nConversa até agora:\n${historyText}` : '',
    '',
    `Usuário: ${userMessage}`,
    'Gerente:',
  ]
    .filter((part) => part !== '')
    .join('\n');
}

export async function askManager({
  sessions,
  history,
  userMessage,
  transcriptExcerpt = null,
  timeoutMs = 30000,
  spawnFn,
  now = Date.now(),
  lang = 'pt',
}) {
  const prompt = buildChatPrompt({
    digest: buildSessionsDigest(sessions, now),
    history,
    userMessage,
    transcriptExcerpt,
    lang,
  });
  const result = await runClaude({ prompt, timeoutMs, ...(spawnFn ? { spawnFn } : {}) });
  return {
    reply: result?.text?.trim() || (lang === 'en' ? 'Oops, I got stuck trying to answer. Try again?' : 'Xii, travei aqui tentando responder 😅 tenta de novo?'),
    tokensUsed: result?.tokens ?? 0,
  };
}
