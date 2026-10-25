// A chat's answer, as speech (#161): short ones read as they are, lists as
// their labels plus an offer to walk them, long ones summarized (Haiku, the
// one place it costs tokens). Code is never read aloud.
const SHORT_CHARS = 300;
// The spoken language follows the voice. The chats answer in Portuguese, so
// for an English voice even a short answer goes through the summarizer, which
// speaks English.
const LINES = {
  pt: {
    counts: ['', 'uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'],
    ordinals: ['', 'Primeiro', 'Segundo', 'Terceiro', 'Quarto', 'Quinto', 'Sexto', 'Sétimo', 'Oitavo', 'Nono', 'Décimo'],
    item: (position) => `Item ${position}`,
    options: (count, labels) => `${count} opções: ${labels}.`,
    and: 'e',
    recommend: /[^.!?:]*recomend[^.!?]*[.!?]?/i,
    offer: 'Quer que eu leia os tópicos?',
    onScreen: 'Terminei, a resposta tá na tela.',
    code: 'Tem código na tela.',
    end: 'Acabaram os tópicos.',
    only: (count) => `Só tem ${count} tópicos.`,
  },
  en: {
    counts: ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
    ordinals: ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'],
    item: (position) => `Item ${position}`,
    options: (count, labels) => `${count} options: ${labels}.`,
    and: 'and',
    recommend: /[^.!?:]*recommend[^.!?]*[.!?]?/i,
    offer: 'Want me to read the topics?',
    onScreen: 'Done, the answer is on screen.',
    code: "There's code on screen.",
    end: "That's all the topics.",
    only: (count) => `There are only ${count} topics.`,
  },
};
const linesOf = (lang) => LINES[lang] ?? LINES.pt;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

function inline(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/^#+\s*/, '')
    .replace(/^>\s?/, '')
    .trim();
}

export function analyzeReply(markdown) {
  const source = String(markdown ?? '');
  const hasCode = /```/.test(source);
  const lines = source.replace(/```[\s\S]*?(```|$)/g, '\n').split('\n');
  const items = [];
  const prose = [];
  for (const line of lines) {
    const item = line.match(LIST_ITEM);
    if (item) items.push(inline(item[1]));
    else if (line.trim()) prose.push(inline(line));
  }
  const plain = [...prose, ...items].join(' ').replace(/\s+/g, ' ').trim();
  return { plain, hasCode, items: items.length >= 2 ? items : null, prose: prose.join(' '), long: plain.length > SHORT_CHARS };
}

const label = (item) => item.split(/:|\s—\s|\s-\s/)[0].trim();
const listOf = (words, and) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} ${and} ${words.at(-1)}`);
const withoutName = (text) => text.replace(/\b(o |a |the )?vizor\b/gi, '').replace(/\s+/g, ' ').trim();

export async function spokenReply(analysis, { summarize, economy = false, lang = 'pt' }) {
  const lines = linesOf(lang);
  let speech;
  let navigable = false;
  if (analysis.items) {
    const count = lines.counts[analysis.items.length] ?? String(analysis.items.length);
    const recommendation = (analysis.prose.match(lines.recommend) ?? [''])[0].trim();
    speech = [lines.options(count, listOf(analysis.items.map(label), lines.and)), recommendation, lines.offer].filter(Boolean).join(' ');
    navigable = true;
  } else if (analysis.long || (lang !== 'pt' && analysis.plain)) {
    const summary = economy ? null : await summarize(analysis.plain).catch(() => null);
    speech = summary || lines.onScreen;
  } else {
    speech = analysis.plain;
  }
  if (analysis.hasCode) speech = `${speech} ${lines.code}`.trim();
  return { speech: withoutName(speech), navigable };
}

export function createReplyCursor(items, lang = 'pt') {
  const lines = linesOf(lang);
  let index = -1;
  const say = (position) => `${lines.ordinals[position + 1] ?? lines.item(position + 1)}: ${items[position]}`;
  return {
    topics() {
      index = 0;
      return say(0);
    },
    next() {
      if (index + 1 >= items.length) return lines.end;
      index += 1;
      return say(index);
    },
    previous() {
      index = Math.max(0, index - 1);
      return say(index);
    },
    repeat() {
      return say(Math.max(0, index));
    },
    detail(position) {
      if (position < 1 || position > items.length) return lines.only(items.length);
      index = position - 1;
      return say(index);
    },
  };
}
