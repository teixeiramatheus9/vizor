import { createHash } from 'node:crypto';
import { runClaude } from './claude-cli.js';

// Turns the user's free-text rules into checks the guard can run without AI
// (#160). The gerente reads them once per change; the user approves each
// translation before it counts, so this only has to be good, not perfect.
const KINDS = new Set(['forbid', 'ask', 'agent']);
const GIT_ACTIONS = new Set(['push', 'merge', 'commit', 'reset-hard', 'branch-delete', 'pr-merge']);
const COMPILE_TIMEOUT_MS = 90000;

const EXAMPLES = [
  ['nunca dar push nem merge na main sem me perguntar', { kind: 'ask', irreversible: true, explain: 'push ou merge na branch principal', match: [{ type: 'git', actions: ['push', 'merge', 'pr-merge'], target: 'default' }] }],
  ['nunca de drop em nada de banco de dados', { kind: 'forbid', irreversible: true, explain: 'DROP ou TRUNCATE em banco', match: [{ type: 'sql', statements: ['DROP', 'TRUNCATE'] }] }],
  ['quando ver o termo PROD em algo avise/pergunte se pode mesmo', { kind: 'ask', irreversible: false, explain: 'algo que menciona PROD', match: [{ type: 'keyword', words: ['prod'] }] }],
  ['não commite nada em branch dos outros de forma automatica', { kind: 'ask', irreversible: false, explain: 'commit ou push numa branch de outra pessoa', match: [{ type: 'git', actions: ['commit', 'push'], target: 'others' }] }],
  ['não se autoreferencie no commit (co-autoria)', { kind: 'agent', irreversible: false, explain: 'commits sem Co-Authored-By nem menção a IA', match: [] }],
  ['leia todas as regras antes de tudo', { kind: 'agent', irreversible: false, explain: 'ler as regras antes de agir', match: [] }],
];

export function buildCompilerPrompt({ lines, scope }) {
  const examples = EXAMPLES.map(([line, rule]) => `Linha: ${line}\nRegra: ${JSON.stringify(rule)}`).join('\n\n');
  return [
    'Você traduz regras de um desenvolvedor, escritas em português livre, em checagens que um hook do Claude Code roda antes de cada ferramenta (Bash, Edit, Write, MultiEdit, NotebookEdit e ferramentas MCP).',
    `Escopo: ${scope === 'global' ? 'regras globais do usuário' : 'regras de um repositório'}.`,
    '',
    'Para cada linha, devolva um objeto com:',
    '- "kind": "forbid" (barrar sempre), "ask" (perguntar ao usuário antes) ou "agent" (não dá pra checar; vira instrução pros agentes).',
    '- "irreversible": true quando a ação não tem volta (push/merge na branch principal, push --force, reset --hard, apagar branch, apagar dados).',
    '- "explain": frase curta em pt-BR dizendo o que a checagem pega.',
    '- "match": lista (qualquer um casa) de checagens, vazia para "agent". Tipos possíveis:',
    '  {"type":"command","pattern":"<regex sem caixa no comando do Bash>"}',
    '  {"type":"git","actions":["push"|"merge"|"commit"|"reset-hard"|"branch-delete"|"pr-merge"],"target":"default"|"any"|"others"|"<nome da branch>","force":true?}',
    '    ("default" = branch principal do repo; "others" = branch cujos commits não são do usuário; "pr-merge" = gh pr merge)',
    '  {"type":"keyword","words":["<palavra inteira, sem caixa>"]} — procura no comando, no caminho e no texto escrito',
    '  {"type":"sql","statements":["DROP","TRUNCATE",...]} — comando, arquivos .sql escritos e ferramentas MCP',
    '  {"type":"tool","pattern":"<regex no nome da ferramenta, ex.: ^mcp__.*__execute_sql$>"}',
    'Prefira palavras inteiras e checagens estreitas: pergunta demais faz o usuário desligar a trava.',
    '',
    'Exemplos:',
    examples,
    '',
    'Responda SÓ com um array JSON, um objeto por linha, na mesma ordem. Linhas:',
    ...lines.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');
}

// The guard runs approved regexes synchronously on every guarded call, and
// JavaScript has no match timeout: a catastrophic pattern would hang the hook
// (and Claude Code with it) until its 600 s timeout. The classic culprit is a
// repeated group that itself repeats — (a+)+, (\w+\s?)*, (.*x){12} — so those
// are refused here, before anyone can approve them, along with patterns too
// long to read (#165). A refused check leaves the line as an agent rule.
const MAX_PATTERN_CHARS = 500;

// Length of a quantifier starting at `index` and whether it repeats (more
// than once); 0 = no quantifier there.
function quantifierAt(pattern, index) {
  const char = pattern[index];
  let length = 0;
  let repeats = false;
  if (char === '*' || char === '+') [length, repeats] = [1, true];
  else if (char === '?') [length, repeats] = [1, false];
  else if (char === '{') {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
    if (!braces) return { length: 0, repeats: false };
    const [whole, min, comma, max] = braces;
    length = whole.length;
    repeats = comma ? max === '' || Number(max) > 1 : Number(min) > 1;
  }
  if (length && pattern[index + length] === '?') length += 1; // lazy
  return { length, repeats };
}

export function isRiskyRegex(pattern) {
  const text = String(pattern);
  if (text.length > MAX_PATTERN_CHARS) return true;
  const groups = [{ repeatsInside: false }];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    let atomEnd = index;
    if (char === '\\') atomEnd = index + 1;
    else if (char === '[') {
      atomEnd = index + 1;
      if (text[atomEnd] === '^') atomEnd++;
      if (text[atomEnd] === ']') atomEnd++;
      while (atomEnd < text.length && text[atomEnd] !== ']') atomEnd += text[atomEnd] === '\\' ? 2 : 1;
    } else if (char === '(') {
      groups.push({ repeatsInside: false });
      // (?: (?= (?! (?<= (?<! (?<name> — the ? there is no quantifier.
      if (text[index + 1] === '?') {
        index += 2;
        if (text[index] === '<' && text[index + 1] !== '=' && text[index + 1] !== '!') index = text.indexOf('>', index);
        else if (text[index] === '<') index += 1;
      }
      continue;
    } else if (char === ')') {
      const group = groups.length > 1 ? groups.pop() : { repeatsInside: false };
      const quantifier = quantifierAt(text, index + 1);
      if (quantifier.repeats && group.repeatsInside) return true;
      const parent = groups[groups.length - 1];
      parent.repeatsInside ||= group.repeatsInside || quantifier.repeats;
      index += quantifier.length;
      continue;
    } else if (char === '|' || char === '^' || char === '$') continue;
    const quantifier = quantifierAt(text, atomEnd + 1);
    if (quantifier.repeats) groups[groups.length - 1].repeatsInside = true;
    index = atomEnd + quantifier.length;
  }
  return false;
}

function validRegex(pattern) {
  try {
    new RegExp(String(pattern), 'i');
    return typeof pattern === 'string' && pattern.length > 0 && !isRiskyRegex(pattern);
  } catch {
    return false;
  }
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);

function cleanMatch(match) {
  switch (match?.type) {
    case 'command':
    case 'tool':
      return validRegex(match.pattern) ? { type: match.type, pattern: match.pattern } : null;
    case 'git': {
      const actions = strings(match.actions).filter((action) => GIT_ACTIONS.has(action));
      if (actions.length === 0) return null;
      const target = typeof match.target === 'string' && match.target ? match.target : 'any';
      return { type: 'git', actions, target, ...(match.force === true ? { force: true } : {}) };
    }
    case 'keyword':
      return strings(match.words).length ? { type: 'keyword', words: strings(match.words) } : null;
    case 'sql':
      return strings(match.statements).length ? { type: 'sql', statements: strings(match.statements) } : null;
    default:
      return null;
  }
}

function ruleId(scope, source) {
  return createHash('sha1').update(`${scope}\n${source}`).digest('hex').slice(0, 12);
}

const UNCOMPILABLE = 'não consegui transformar em trava';

function cleanRule(raw, source, scope) {
  const id = ruleId(scope, source);
  const agent = (explain) => ({ id, source, kind: 'agent', irreversible: false, explain, match: [] });
  if (!raw || typeof raw !== 'object' || !KINDS.has(raw.kind)) return agent(UNCOMPILABLE);
  const explain = typeof raw.explain === 'string' && raw.explain ? raw.explain : '';
  if (raw.kind === 'agent') return agent(explain || UNCOMPILABLE);
  const match = (Array.isArray(raw.match) ? raw.match : []).map(cleanMatch).filter(Boolean);
  if (match.length === 0) return agent(UNCOMPILABLE);
  return { id, source, kind: raw.kind, irreversible: raw.irreversible === true, explain, match };
}

function firstArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseCompilerOutput(text, lines, scope) {
  const array = firstArray(String(text ?? ''));
  if (!array) return null;
  return lines.map((line, index) => cleanRule(array[index], line, scope));
}

export async function compileRules({ lines, scope, run = runClaude, budget, budgetDaily }) {
  if (budget.isExceeded(budgetDaily)) return { error: 'sem-orcamento' };
  const prompt = buildCompilerPrompt({ lines, scope: scope === 'global' ? 'global' : 'repo' });
  const result = await run({ prompt, model: 'sonnet', timeoutMs: COMPILE_TIMEOUT_MS });
  if (!result) return { error: 'sem-claude' };
  budget.add(result.tokens);
  const drafts = parseCompilerOutput(result.text, lines, scope);
  return drafts ? { drafts } : { error: 'resposta-invalida' };
}

// The rules window's "editar": the user's JSON goes through the same cleaning
// as the compiler's. An edit that would quietly stop locking (a typo in a
// type, a bad kind) is refused instead of shown as "proibido".
export function validateEditedRule(draft, edited) {
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) return null;
  if (!KINDS.has(edited.kind)) return null;
  if (edited.explain !== undefined && typeof edited.explain !== 'string') return null;
  if (edited.kind !== 'agent' && !Array.isArray(edited.match)) return null;
  const rule = { ...cleanRule(edited, draft.source, 'edit'), id: draft.id };
  if (edited.kind !== 'agent' && rule.kind === 'agent') return null;
  if (edited.kind !== 'agent' && rule.match.length !== edited.match.length) return null;
  return rule;
}
