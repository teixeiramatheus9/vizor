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

const WORK_VERB =
  /\b(puxa|puxar|puxe|pega|pegar|pegue|comeca|comecar|comece|desenvolve|desenvolver|desenvolva|implementa|implementar|implemente|trabalhar|trabalha|trabalhe|faz|fazer|faca|analisa|analisar|analise|resolve|resolver|resolva)\b/;
const NOT_WORK = /\b(revis\w*|fecha\w*|atribu\w*|assign\w*)\b/;
// "isue", "eixo", "eixe": how the transcriber writes "issue" (live test).
const ISSUE_WORD = /^(issues?|isues?|issu|eixos?|eixe|ixus?|task|tarefa)$/;
const PICK_VERB = /^(puxa|puxe|puxar|pega|pegue|pegar)$/;
const SPOKEN_DIGIT = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, meia: 6, sete: 7, oito: 8, nove: 9 };
const FILLER = new Set(['e', 'a', 'o', 'numero', 'de', 'da', 'do', '#']);

// A number as it was transcribed: "169", "1 6 9", "um meia 9", "160 e 9".
function spokenNumber(tokens) {
  const parts = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) parts.push(token);
    else if (token in SPOKEN_DIGIT) parts.push(String(SPOKEN_DIGIT[token]));
    else if (token === 'e' && parts.length) parts.push('e');
    else if (!parts.length && FILLER.has(token)) continue;
    else break;
  }
  let value = '';
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== 'e') value += parts[index];
    // "160 e 9" is 169; any other "e" ends the number ("22 e depois").
    else if (value.endsWith('0') && parts[index + 1]?.length === 1) value = value.slice(0, -1) + parts[++index];
    else break;
  }
  return value ? Number(value) : null;
}

// A phrase that asks for work ("bora começar aquela do menu"): worth a look
// by the interpreter when no command matched it (live test).
export function soundsLikeWork(text) {
  const plain = norm(text);
  return WORK_VERB.test(plain) && !NOT_WORK.test(plain);
}

// The issue a phrase talks about: after an issue word, or right after
// "puxa/pega" ("pega a 169"). Null when there is none.
export function issueNumberIn(text) {
  const tokens = norm(text).split(' ');
  const named = tokens.findIndex((token) => ISSUE_WORD.test(token));
  if (named !== -1) return spokenNumber(tokens.slice(named + 1));
  const verb = tokens.findIndex((token) => PICK_VERB.test(token));
  return verb !== -1 ? spokenNumber(tokens.slice(verb + 1)) : null;
}
const taskAction = (action, number = null) => ({ type: 'task-action', action, number: number ? Number(number) : null });
const HANDOVER = /\b(da|de|passa|passe|manda|mande|entrega|entregue)\b.*\b(ela|essa|isso|esta)\b.*\b(musico|chat|agente)\b/;

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
  [/^(puxa|puxe|puxar|pega|pegue|pegar) a (issue|isue|issu|task|tarefa) (numero )?(\d+)$/, (match) => ({ type: 'pick-issue', number: Number(match[4]) })],
  [/^(revisa|revise|revisar|manda revisar|pede (a )?revisao d[ae]) (a )?(pr|pull request) (numero )?(\d+)$/, (match) => ({ type: 'review-pr', number: Number(match[6]) })],
  // The plan card's buttons, of the chat in front or of a task.
  [/^(aprova|aprovo|aprovar|aprove) (o )?plano( d[ao] (task |tarefa |issue )?(\d+))?$/, (match) => ({ type: 'approve-plan', number: match[5] ? Number(match[5]) : null })],
  [/^(o )?plano (ta |esta )?aprovado$/, () => ({ type: 'approve-plan', number: null })],
  // The contract flow (the plan card's buttons): of the chat in front or of a task.
  [/^(aprova|aprovo|aprovar|aprove) (o )?contrato( d[ao] (task |tarefa |issue )?(\d+))?$/, (match) => taskAction('approve-contract', match[5])],
  [/^(o )?contrato (ta |esta )?aprovado$/, () => taskAction('approve-contract')],
  [/^(aprova|aprovo|aprovar|aprove) (os )?testes( d[ao] (task |tarefa |issue )?(\d+))?$/, (match) => taskAction('approve-tests', match[5])],
  // Bare "segue"/"pode seguir" may be an answer to the chat: only "ok" or the step named.
  [/^(ok (segue|seguir|pode seguir|segue em frente)|(segue pro |vai pro )?proximo passo)$/, () => taskAction('next-step')],
  [/^(qual (e )?)?(a )?(minha|sua) vez$/, () => taskAction('my-turn')],
  [/^(destrava|destrave|destravar|libera|liberar) (os )?testes( d[ao] (task |tarefa |issue )?(\d+))?$/, (match) => taskAction('unlock-tests', match[5])],
  [/^(abre|abrir|abra) (a )?(pr|pull request)( d[ao] (task |tarefa |issue )?(\d+))?$/, (match) => ({ type: 'open-pr', number: match[6] ? Number(match[6]) : null })],
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
  // Memory (#163): where a task stopped, and routines of spoken steps.
  [/^onde (a gente |nos |voces )?(paramos|parou|parei) na (task |tarefa |issue )?(\d+)$/, (match) => ({ type: 'where-stopped', number: Number(match[4]) })],
  [/^(grava|grave|gravar|salva|salve|salvar) (a |uma )?rotina( .*)?$/, (match, raw) => saveRoutine(raw)],
  [/^(roda|rode|rodar|comeca|comecar|executa|execute) (a )?rotina (.+)$/, (match, raw) => ({ type: 'run-routine', name: routineName(rawTail(raw, match[3])) })],
  [/^quais (sao )?(as )?rotinas( eu tenho| que eu tenho| temos)?$/, () => ({ type: 'list-routines' })],
  [/^(esquece|esqueca|apaga|apague|remove) (a )?rotina (.+)$/, (match, raw) => ({ type: 'forget-routine', name: routineName(rawTail(raw, match[3])) })],
  // The conducting gerente (#162): an order kept until the músico finishes,
  // and the reviewer. "o A1"/"a1" is a músico without a task, "a 22" a task.
  [/^quando (o (a|agente) ?|a(?=\d)|agente ?)(\d+) (terminar|acabar) (.+)$/, (match, raw) => ({ type: 'when-done', agent: Number(match[3]), text: rawTail(raw, match[5]) })],
  [/^quando (a |o )?(task |tarefa |issue )?(\d+) (terminar|acabar) (.+)$/, (match, raw) => ({ type: 'when-done', number: Number(match[3]), text: rawTail(raw, match[5]) })],
  [/^(chama|chame|chamar) (um )?avaliador (pro |para o )(a|agente) ?(\d+)$/, (match) => ({ type: 'call-reviewer', agent: Number(match[5]) })],
  [/^(chama|chame|chamar) (um )?avaliador (pra |para )(a(?=\d)|agente ?)(\d+)$/, (match) => ({ type: 'call-reviewer', agent: Number(match[5]) })],
  [/^(chama|chame|chamar) (um )?avaliador (pra|para|pro) (a |o )?(task |tarefa |issue )?(\d+)$/, (match) => ({ type: 'call-reviewer', number: Number(match[6]) })],
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
  // Starting work on an issue, said any way (live test: "vamos pegar issue
  // #162 e analisar…", "pegue a issue 162 e vamos começar a desenvolvê-la"):
  // a work verb and "issue/task N", never a review, a close or an assign.
  [{ test: (text) => WORK_VERB.test(text) && issueNumberIn(text) !== null && !NOT_WORK.test(text) }, (match) => ({ type: 'pick-issue', number: issueNumberIn(match[0]) })],
  // "dê ela para um músico": the issue last talked about (the session knows it).
  [{ test: (text) => HANDOVER.test(text) && !NOT_WORK.test(text) }, () => ({ type: 'pick-issue', number: null })],
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

// "grava a rotina <nome>: passo, depois passo; e depois passo". The name ends
// at ":", at "com os passos" or, failing those, at the first comma. ";" always
// splits; "depois" splits too, except inside a "quando … terminar" order,
// which keeps its own "e depois" (review).
const DEPOIS = /,?\s+e\s+depois\s+|,?\s+depois\s+/i;
const routineName = (name) => name.trim().replace(/^(de|do|da)\s+/i, '').trim();

function saveRoutine(raw) {
  const named = raw.search(/rotina/i);
  if (named === -1) return { type: 'save-routine-invalid' };
  const rest = raw.slice(named + 'rotina'.length);
  const cut = rest.match(/:|\s+com os passos\s+|,/i);
  if (!cut) return { type: 'save-routine-invalid' };
  const name = routineName(rest.slice(0, cut.index));
  const steps = rest
    .slice(cut.index + cut[0].length)
    .split(/\s*;\s*(?:e\s+)?(?:depois\s+)?/)
    .flatMap((clause) => (/^\s*quando\b/i.test(clause) ? [clause] : clause.split(DEPOIS)))
    .map((step) => step.trim().replace(/[.!]+$/, ''))
    .filter(Boolean);
  return name && steps.length ? { type: 'save-routine', name, steps } : { type: 'save-routine-invalid' };
}

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
