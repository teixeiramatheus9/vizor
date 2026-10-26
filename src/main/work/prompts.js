// What the Vizor asks a músico, the same whether the order came by voice or
// by the keyboard. The plan goes to a file the Vizor follows live (plan.js).
import { PLAN_FILE } from './plan.js';

export const startIssuePrompt = (number) =>
  `Vamos trabalhar na issue #${number}. Leia com \`gh issue view ${number}\` e escreva o plano em \`${PLAN_FILE}\` ` +
  'como uma checklist curta em pt-BR (uma linha `- [ ] passo` por passo, de 3 a 8 passos), ' +
  'terminando com uma linha `Vizor-plano: caminho/arquivo.js#funcao, outro/arquivo.js` (caminhos relativos à raiz do projeto). ' +
  'Depois espere meu ok antes de mexer no código. Quando eu aprovar, a cada passo concluído troque o `- [ ]` dele por `- [x]` no arquivo.';

export const APPROVE_PROMPT = `Plano aprovado, pode seguir. A cada passo concluído, marque \`- [x]\` no \`${PLAN_FILE}\`.`;

export const OPEN_PR_PROMPT = 'Rode os testes do projeto. Se passarem, faça o commit e abra a PR com `gh pr create`; se falharem, me diga o que quebrou.';

// A reviewer reports and changes nothing.
export const reviewPrPrompt = (number) =>
  `Revise a PR #${number}: leia com \`gh pr view ${number}\` e \`gh pr diff ${number}\`, aponte os problemas por gravidade com arquivo e linha, e não mude código nem publique comentários sem eu pedir.`;

// The tab of a chat opened for a task carries its number and title, short.
const TAB_MAX = 32;
export function taskTabTitle(number, title) {
  const full = title ? `#${number} ${String(title).trim()}` : `#${number}`;
  if (full.length <= TAB_MAX) return full;
  let cut = full.slice(0, TAB_MAX - 2);
  if (full[TAB_MAX - 2] !== ' ') cut = cut.replace(/\s+\S*$/, '');
  return `${cut}…`;
}
