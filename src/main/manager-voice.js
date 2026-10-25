import { runClaude } from './claude-cli.js';

export const FALLBACK_PHRASES = [
  (projectName) => `Opa, aquela tarefa do '${projectName}' já terminou, dá uma olhada lá po!`,
  (projectName) => `E aí, o chat '${projectName}' acabou o serviço. Confere lá!`,
  (projectName) => `Terminou! O '${projectName}' tá esperando teu veredito.`,
  (projectName) => `Missão cumprida no '${projectName}'. Vai lá ver como ficou!`,
];

export const WAITING_PHRASES = [
  'Dá uma olhada aqui e me fala como seguir!',
  'Esperando você dizer como continua.',
  'Me fala aí como ficou essa task!',
  'Preciso de você aqui rapidinho!',
];

// The same lines for an English voice: what the gerente says follows the voice.
const FALLBACK_PHRASES_EN = [
  (projectName) => `Hey, that task in '${projectName}' is done, take a look!`,
  (projectName) => `The '${projectName}' chat just wrapped up. Check it out!`,
  (projectName) => `Done! '${projectName}' is waiting for your call.`,
  (projectName) => `Mission accomplished in '${projectName}'. Go see how it turned out!`,
];

const WAITING_PHRASES_EN = [
  'Take a look here and tell me how to go on!',
  'Waiting for you to say how it continues.',
  'Tell me how this task turned out!',
  'I need you here for a sec!',
];

// A permission ask is the red-alert flavor of Notification — detected on the
// RAW message, because humanizeNotification rewrites it right after.
export function isPermissionAsk(message) {
  return /permission to use/i.test(String(message ?? ''));
}

// Claude Code notifications arrive in English ("Claude is waiting for your
// input", "Claude needs your permission to use Bash") — turn them into the
// manager's casual pt-BR voice.
export function humanizeNotification(message, random = Math.random, lang = 'pt') {
  const original = String(message ?? '');
  const permissionMatch = original.match(/permission to use (\S+)/i);
  if (permissionMatch) {
    const tool = permissionMatch[1].replace(/[.,;:!?]+$/, '');
    return lang === 'en' ? `It wants your permission to use ${tool}, allow it?` : `Quer tua permissão pra usar ${tool} — libera aí?`;
  }
  const phrases = lang === 'en' ? WAITING_PHRASES_EN : WAITING_PHRASES;
  return phrases[Math.floor(random() * phrases.length)];
}

// No title here on purpose. This is what comes out when claude -p fails or
// economy mode is on, and a generic "Tarefa concluída" would overwrite the
// chat's subject with something the status dot and label already say.
export function fallbackMessage(projectName, random = Math.random, lang = 'pt') {
  const phrases = lang === 'en' ? FALLBACK_PHRASES_EN : FALLBACK_PHRASES;
  const phrase = phrases[Math.floor(random() * phrases.length)];
  return { message: phrase(projectName) };
}

export function buildPrompt(projectName, lastAssistantMessage, lang = 'pt') {
  const context = lastAssistantMessage
    ? `Última resposta do assistente nessa sessão (pode estar truncada):\n"""\n${lastAssistantMessage}\n"""`
    : 'Não há transcript disponível — seja genérico.';
  return [
    'Você é o "gerente" descontraído das sessões do Claude Code do usuário.',
    `Uma sessão do projeto '${projectName}' acabou de terminar uma tarefa.`,
    context,
    'Responda SOMENTE com JSON válido neste formato: {"title": "...", "message": "..."}',
    '- "title": máximo 6 palavras, em pt-BR, nomeando o ASSUNTO do chat (do que',
    '  essa conversa trata como um todo), não o que acabou de ser feito agora.',
    lang === 'en'
      ? `- "message": 1 to 2 sentences in casual American English, like "Hey, that task in '${projectName}' is done, take a look", briefly saying what was done. It is spoken by an English voice.`
      : `- "message": 1 a 2 frases em pt-BR bem informal, estilo "Opa, aquela tarefa do '${projectName}' terminou, dá uma olhada lá po", mencionando brevemente o que foi feito.`,
    'Nada de markdown, nada de texto fora do JSON.',
  ].join('\n');
}

export function parseVoiceResponse(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    if (typeof parsed.title === 'string' && typeof parsed.message === 'string') {
      return { title: parsed.title.trim(), message: parsed.message.trim() };
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function generateManagerMessage({
  projectName,
  lastAssistantMessage,
  timeoutMs = 15000,
  spawnFn,
  lang = 'pt',
}) {
  const result = await runClaude({
    prompt: buildPrompt(projectName, lastAssistantMessage, lang),
    timeoutMs,
    ...(spawnFn ? { spawnFn } : {}),
  });
  // tokens count even when the reply fails to parse — they were spent.
  const tokensUsed = result?.tokens ?? 0;
  const parsed = result ? parseVoiceResponse(result.text) : null;
  return { ...(parsed ?? fallbackMessage(projectName, Math.random, lang)), tokensUsed };
}
