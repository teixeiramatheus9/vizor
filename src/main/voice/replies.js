// A chat's answer, as speech (#161): short ones read as they are, lists as
// their labels plus an offer to walk them, long ones summarized (Haiku, the
// one place it costs tokens). Code is never read aloud.
const SHORT_CHARS = 300;
const COUNT_WORDS = ['', 'uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'];
const ORDINAL_WORDS = ['', 'Primeiro', 'Segundo', 'Terceiro', 'Quarto', 'Quinto', 'Sexto', 'Sétimo', 'Oitavo', 'Nono', 'Décimo'];
const ON_SCREEN = 'Terminei, a resposta tá na tela.';
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
const listOf = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} e ${words.at(-1)}`);
const withoutName = (text) => text.replace(/\b(o |a )?vizor\b/gi, '').replace(/\s+/g, ' ').trim();

export async function spokenReply(analysis, { summarize, economy = false }) {
  let speech;
  let navigable = false;
  if (analysis.items) {
    const count = COUNT_WORDS[analysis.items.length] ?? String(analysis.items.length);
    const recommendation = (analysis.prose.match(/[^.!?:]*recomend[^.!?]*[.!?]?/i) ?? [''])[0].trim();
    speech = [`${count} opções: ${listOf(analysis.items.map(label))}.`, recommendation, 'Quer que eu leia os tópicos?'].filter(Boolean).join(' ');
    navigable = true;
  } else if (analysis.long) {
    const summary = economy ? null : await summarize(analysis.plain).catch(() => null);
    speech = summary || ON_SCREEN;
  } else {
    speech = analysis.plain;
  }
  if (analysis.hasCode) speech = `${speech} Tem código na tela.`.trim();
  return { speech: withoutName(speech), navigable };
}

export function createReplyCursor(items) {
  let index = -1;
  const say = (position) => `${ORDINAL_WORDS[position + 1] ?? `Item ${position + 1}`}: ${items[position]}`;
  return {
    topics() {
      index = 0;
      return say(0);
    },
    next() {
      if (index + 1 >= items.length) return 'Acabaram os tópicos.';
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
      if (position < 1 || position > items.length) return `Só tem ${items.length} tópicos.`;
      index = position - 1;
      return say(index);
    },
  };
}
