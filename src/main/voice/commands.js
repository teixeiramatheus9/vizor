import { numbersToDigits, soundsLikeWakeWord } from './vocabulary.js';

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
    .replace(/[?!.,;:…#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const NOT_A_NAME = new Set(['e', 'me', 'pra', 'para', 'que', 'com', 'mas', 'depois', 'ai', 'entao', 've', 'olha']);

const STATUS = [
  /^o que (a gente tem|temos|tem) (pra|para) (hoje|fazer)$/,
  /^(qual (e )?o )?status( do projeto| do github)?$/,
  /^como (ta|esta) o (ci|build|github|projeto|repo)$/,
  /^o que (ta|esta) rolando( no github| no projeto| no repo| hoje)?$/,
  /^o que tem (aberto|pendente)( no github)?$/,
  /^(quantas|quantos|quais|tem) (issues?|prs?|pull requests?|tarefas)( que)?( a gente)?( tem| temos| esta| estao| ta| tao)?( abertas?| abertos?| pendentes?)?( no github)?$/,
];

const ALWAYS = [
  [{ test: (text) => STATUS.some((pattern) => pattern.test(text)) }, () => ({ type: 'status' })],
  // The músicos act on the GitHub (#159): a new chat starts the issue, or
  // reviews the PR.
  [/^(puxa|puxe|puxar|pega|pegue|pegar) a (issue|task|tarefa) (numero )?(\d+)$/, (match) => ({ type: 'pick-issue', number: Number(match[4]) })],
  [/^(revisa|revise|revisar|manda revisar|pede (a )?revisao d[ae]) (a )?(pr|pull request) (numero )?(\d+)$/, (match) => ({ type: 'review-pr', number: Number(match[6]) })],
  [/^(retoma|retomar|volta (pra|para)|abre|abrir|continua|continuar) (a |o )?(task|tarefa|issue|pr|demanda) (numero )?(\d+)$/, (match) => ({ type: 'resume-task', number: Number(match[6]) })],
  [/^(fala|falar|conversa) com o chat (da |do |de )?(.+)$/, (match, raw) => ({ type: 'talk-to-chat', query: rawTail(raw, match[3]) })],
  [/^(volta (pro|para o) gerente|fala com o gerente|gerente)$/, () => ({ type: 'talk-to-manager' })],
  [/^esconde o chat$/, () => ({ type: 'workspace', action: 'hide-chat' })],
  [/^mostra o chat$/, () => ({ type: 'workspace', action: 'show-chat' })],
  [/^mostra (o diff|as mudancas)$/, () => ({ type: 'workspace', action: 'show-diff' })],
  // Only a bare name (up to 4 words, no connective): "abre o arquivo X e me
  // explica…" is a prompt for the chat.
  [/^abre o arquivo (.+)$/, (match, raw) => {
    const words = match[1].split(' ');
    if (words.length > 4 || words.some((word) => NOT_A_NAME.has(word))) return null;
    return { type: 'workspace', action: 'open-file', file: rawTail(raw, match[1]) };
  }],
  // The Maestro (#159): interrupting takes the whole phrase, never a bare
  // "para"; the mode only turns on when asked for by name.
  // A músico without a task is A1, A2… ("o A1", "o agente 1", "a2"); "a 2"
  // with a space stays the article before a task number.
  [/^(interrompa|interrompe|interromper) (o (a|agente) ?|a(?=\d)|agente ?)(\d+)$/, (match) => ({ type: 'interrupt', agent: Number(match[4]) })],
  [/^(vai (pro|pra|para o|para) |foca no |foca na )(o (a|agente) ?|a(?=\d)|agente ?)(\d+)$/, (match) => ({ type: 'focus', agent: Number(match[5]) })],
  [/^(interrompa|interrompe|interromper) a (task|tarefa|issue) (numero )?(\d+)$/, (match) => ({ type: 'interrupt', number: Number(match[4]) })],
  [/^(vai (pra|para) (a )?|foca na )(task |tarefa |issue )?(\d+)$/, (match) => ({ type: 'focus', number: Number(match[5]) })],
  [/^(ative|ativa|ativar) (o )?modo maestro$/, () => ({ type: 'maestro', on: true })],
  [/^(desative|desativa|desativar|sai do) (o )?modo maestro$/, () => ({ type: 'maestro', on: false })],
  [/^(para|cala( a boca)?|silencio|chega|pode parar)$/, () => ({ type: 'stop' })],
  // "ditar" is the word every model missed on the user's voice ("vou de
  // tentar", "vou de ter", "vou editar"): those count too.
  [/^(vou|vo|voo) (ditar|de tar|de ter|de terra|de tentar|editar|de ditar)$|^(modo )?ditado$/, () => ({ type: 'dictate' })],
];

// An order the Maestro holds for a few seconds ("entendi: …"): dropped or sent now.
const WHEN_ORDER = [
  [/^(cancela|nao espera|espera|nao)$/, () => ({ type: 'order', action: 'cancel' })],
  [/^(manda|pode|pode mandar)$/, () => ({ type: 'order', action: 'now' })],
];

// "não, é pty-host" — only right after an utterance, and only a name: "não é
// pra usar var aqui" is a prompt.
const WHEN_CORRECTING = [
  [/^nao,? (e|eh|era|quis dizer) (\S+( \S+){0,3})$/, (match, raw) => ({ type: 'correct', meant: rawTail(raw, match[2]) })],
];

const CHOICES = { primeira: 1, primeiro: 1, segunda: 2, segundo: 2, terceira: 3, terceiro: 3, quarta: 4, quarto: 4, quinta: 5, quinto: 5 };
const WHEN_CHOOSING = [
  [/^((a|o|na|no|pela|pelo) )?(\w+)$/, (match) => {
    const index = CHOICES[match[3]] ?? Number(match[3]);
    return Number.isInteger(index) && index > 0 ? { type: 'choose', index } : null;
  }],
];

const WHEN_ASKING = [
  [/^libera (nesta|nessa|essa|pra essa) sessao$/, () => ({ type: 'guard', choice: 'liberar-sessao' })],
  [/^(libera|liberado|pode seguir|pode ir)$/, () => ({ type: 'guard', choice: 'liberar' })],
  // A bare "não" may be for the chat: only explicit words answer the trava.
  [/^(barra|bloqueia|nao pode|barrado)$/, () => ({ type: 'guard', choice: 'barrar' })],
];

const WHEN_CONFIRMING = [
  [/^(sim|pode|isso|claro|manda ver|beleza|ok|pode sim|bora)$/, () => ({ type: 'confirm', yes: true })],
  [/^(nao|nao,? deixa|deixa|cancela|esquece|nao precisa)$/, () => ({ type: 'confirm', yes: false })],
];

const WHEN_REPLY = [
  [/^((le|leia) (os topicos|os itens|a lista)|leus topicos)$/, () => ({ type: 'navigate', action: 'topics' })],
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
    const match = pattern instanceof RegExp ? text.match(pattern) : pattern.test(text) ? [text] : null;
    const intent = match && build(match, raw);
    if (intent) return intent;
  }
  return null;
}

export function routeUtterance(
  utterance,
  {
    target = 'manager',
    pendingAsk = false,
    hasLastReply = false,
    pendingConfirm = false,
    canCorrect = false,
    pendingChoice = false,
    pendingOrder = false,
  } = {},
) {
  let raw = numbersToDigits(String(utterance ?? '').trim());
  // The wake word comes along in the transcript, spelled as Whisper heard it
  // — maybe after a short word the pre-roll caught ("no Pfizer, …").
  const [first = '', second = ''] = raw.split(/[\s,.!:]+/);
  const wakeWord = soundsLikeWakeWord(first) ? first : first.length <= 3 && soundsLikeWakeWord(second) ? second : null;
  const forced = WAKE.test(raw) || Boolean(wakeWord);
  if (wakeWord) raw = raw.slice(raw.indexOf(wakeWord) + wakeWord.length).replace(/^[\s,.!:]+/, '').trim();
  else if (forced) raw = raw.replace(WAKE, '').trim();
  const text = norm(raw);
  const intent =
    (pendingOrder && firstMatch(WHEN_ORDER, text, raw)) ||
    (pendingChoice && firstMatch(WHEN_CHOOSING, text, raw)) ||
    (pendingAsk && firstMatch(WHEN_ASKING, text, raw)) ||
    (canCorrect && firstMatch(WHEN_CORRECTING, text, raw)) ||
    (pendingConfirm && firstMatch(WHEN_CONFIRMING, text, raw)) ||
    (hasLastReply && firstMatch(WHEN_REPLY, text, raw)) ||
    firstMatch(ALWAYS, text, raw);
  if (intent) return intent;
  if (target === 'chat' && !forced) return { type: 'prompt', text: raw };
  return { type: 'ask-manager', text: raw };
}
