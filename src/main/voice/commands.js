import { numbersToDigits } from './vocabulary.js';

// Spoken Vizor commands (#161), recognized locally — never by the LLM. A
// pattern must match the WHOLE utterance: "para de usar var nesse arquivo" is
// a prompt for the chat, "para" alone stops the voice. Context flags keep
// short answers ("sim", "libera") from being commands when nothing asked.

const WAKE = /^(vizor|visor|vaizor|vaisor)[\s,.!:]+/i;
const ORDINALS = { primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6, setimo: 7, oitavo: 8, nono: 9, decimo: 10 };

// Lower case, no accents, no punctuation — the form patterns are written in.
const norm = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[?!.,;:…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ALWAYS = [
  [/^(o que (a gente tem|temos|tem) (pra|para) (hoje|fazer)|qual (e )?o status( do projeto)?|status( do projeto)?|como (ta|esta) o (ci|build|github)|o que tem (aberto|pendente)( no github)?)$/, () => ({ type: 'status' })],
  [/^(retoma|retomar|volta (pra|para)|abre|abrir|continua|continuar) (a |o )?(task|tarefa|issue|pr|demanda) (numero )?(\d+)$/, (match) => ({ type: 'resume-task', number: Number(match[6]) })],
  [/^(fala|falar|conversa) com o chat (da |do |de )?(.+)$/, (match, raw) => ({ type: 'talk-to-chat', query: rawTail(raw, match[3]) })],
  [/^(volta (pro|para o) gerente|fala com o gerente|gerente)$/, () => ({ type: 'talk-to-manager' })],
  [/^esconde o chat$/, () => ({ type: 'workspace', action: 'hide-chat' })],
  [/^mostra o chat$/, () => ({ type: 'workspace', action: 'show-chat' })],
  [/^mostra (o diff|as mudancas)$/, () => ({ type: 'workspace', action: 'show-diff' })],
  [/^abre o arquivo (.+)$/, (match, raw) => ({ type: 'workspace', action: 'open-file', file: rawTail(raw, match[1]) })],
  [/^(para|cala( a boca)?|silencio|chega|pode parar)$/, () => ({ type: 'stop' })],
  [/^(vou ditar|modo ditado)$/, () => ({ type: 'dictate' })],
  [/^nao,? (e|eh|era|quis dizer) (.+)$/, (match, raw) => ({ type: 'correct', meant: rawTail(raw, match[2]) })],
];

const WHEN_ASKING = [
  [/^libera (nesta|nessa|essa|pra essa) sessao$/, () => ({ type: 'guard', choice: 'liberar-sessao' })],
  [/^(libera|liberado|pode seguir|pode ir)$/, () => ({ type: 'guard', choice: 'liberar' })],
  [/^(barra|bloqueia|nao pode|nao)$/, () => ({ type: 'guard', choice: 'barrar' })],
];

const WHEN_CONFIRMING = [
  [/^(sim|pode|isso|claro|manda ver|beleza|ok|pode sim|bora)$/, () => ({ type: 'confirm', yes: true })],
  [/^(nao|nao,? deixa|deixa|cancela|esquece|nao precisa)$/, () => ({ type: 'confirm', yes: false })],
];

const WHEN_REPLY = [
  [/^(le|leia) (os topicos|os itens|a lista)$/, () => ({ type: 'navigate', action: 'topics' })],
  [/^(o )?proximo$/, () => ({ type: 'navigate', action: 'next' })],
  [/^(volta|anterior|o anterior)$/, () => ({ type: 'navigate', action: 'previous' })],
  [/^(repete|repete isso|de novo|fala de novo)$/, () => ({ type: 'navigate', action: 'repeat' })],
  [/^detalha o (\w+)( item| topico)?$/, (match) => {
    const index = ORDINALS[match[1]] ?? Number(match[1]);
    return Number.isInteger(index) && index > 0 ? { type: 'navigate', action: 'detail', index } : null;
  }],
];

// The original spelling of a matched tail (a file name keeps its case).
function rawTail(raw, normalizedTail) {
  const words = raw.trim().split(/\s+/);
  for (let count = 1; count <= words.length; count++) {
    const tail = words.slice(-count).join(' ');
    if (norm(tail) === normalizedTail) return tail.replace(/[?!.,;:…]+$/, '');
  }
  return normalizedTail;
}

function firstMatch(rules, text, raw) {
  for (const [pattern, build] of rules) {
    const match = text.match(pattern);
    const intent = match && build(match, raw);
    if (intent) return intent;
  }
  return null;
}

export function routeUtterance(utterance, { target = 'manager', pendingAsk = false, hasLastReply = false, pendingConfirm = false } = {}) {
  let raw = numbersToDigits(String(utterance ?? '').trim());
  const forced = WAKE.test(raw);
  if (forced) raw = raw.replace(WAKE, '').trim();
  const text = norm(raw);
  const intent =
    (pendingAsk && firstMatch(WHEN_ASKING, text, raw)) ||
    (pendingConfirm && firstMatch(WHEN_CONFIRMING, text, raw)) ||
    (hasLastReply && firstMatch(WHEN_REPLY, text, raw)) ||
    firstMatch(ALWAYS, text, raw);
  if (intent) return intent;
  if (target === 'chat' && !forced) return { type: 'prompt', text: raw };
  return { type: 'ask-manager', text: raw };
}
