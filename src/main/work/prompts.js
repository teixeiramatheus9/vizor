// What the Vizor asks a músico, the same whether the order came by voice or
// by the keyboard. The plan goes to a file the Vizor follows live (plan.js).
import { planFileName } from './plan.js';

// The fluxo real test: a músico that opened the app to check its work stole
// the dev's screen. Every order of the task flow repeats it.
const NO_GUI = 'Não abra o app, GUI nem ferramentas de X; a conferência visual fica pro dev.';

export const startIssuePrompt = (number) =>
  `Vamos trabalhar na issue #${number}. Leia com \`gh issue view ${number}\` e escreva o plano em \`${planFileName(number)}\`, em pt-BR, com duas seções: ` +
  '`## Contrato`, de 2 a 6 casos de aceitação (uma linha `- situação → resultado esperado` por caso), e ' +
  '`## Passos`, uma checklist curta (uma linha `- [ ] passo` por passo, de 3 a 8 passos). ' +
  'Marque com `[dev]` (`- [ ] [dev] passo`) o passo da lógica central, que eu escrevo à mão (no máximo 2). ' +
  'Termine com uma linha `Vizor-plano: caminho/arquivo.js#funcao, outro/arquivo.js` (caminhos relativos à raiz do projeto). ' +
  'Depois pare e espere eu aprovar o contrato antes de mexer no código. ' +
  'A cada passo concluído, troque o `- [ ]` dele por `- [x]` e ponha logo abaixo uma linha recuada `  porquê: …` (no máximo 2 frases). ' +
  NO_GUI;

export const CONTRACT_APPROVED_PROMPT =
  'Contrato aprovado. Agora escreva os testes que provam o contrato, sem o código da solução: ' +
  'primeiro liste os arquivos de teste no plano numa linha `Vizor-contrato: caminho/um.test.js, caminho/outro.test.js` (relativos à raiz), ' +
  'depois escreva os testes e ponha o comando que roda só eles numa linha `Vizor-teste: comando` (uma linha só). ' +
  `Rode uma vez pra ver que falham pelo motivo certo e pare. ${NO_GUI}`;

export const NEXT_STEP_PROMPT =
  'Ok, segue: faça só o próximo passo do plano, marque o `- [x]` dele com a linha `porquê:` logo abaixo e pare. ' +
  `Se o próximo passo for [dev], prepare o andaime, deixe \`TODO(dev): …\` onde a lógica entra e pare. ${NO_GUI}`;

export const devStepPrompt = (text) =>
  `O próximo passo é meu ([dev]): ${text}. Prepare o andaime (arquivos, assinaturas, chamadas), ` +
  `deixe um comentário \`TODO(dev): …\` onde a lógica entra, sem escrever a lógica, e pare. ${NO_GUI}`;

export const DEV_DONE_PROMPT =
  `Fiz o passo [dev]; rode os testes e continue: marque esse passo com \`- [x]\` e o \`porquê:\`, e pare antes do próximo. ${NO_GUI}`;

export const TRUST_PROMPT =
  'Modo confiança: siga os passos do plano até o fim, marcando cada `- [x]` com o `porquê:` logo abaixo. ' +
  `Num passo [dev], prepare o andaime, deixe \`TODO(dev): …\` e pare. ${NO_GUI}`;

export const undoStepPrompt = (n, text) =>
  `Desfaça o passo ${n} (${text}): volte o código que esse passo mudou, troque o \`- [x]\` dele por \`- [ ]\` e pare. ${NO_GUI}`;

export const restoredPrompt = (n, left) =>
  `Voltei os arquivos pra antes do passo ${n} (nada foi apagado). ` +
  (left.length ? `Ficaram arquivos criados depois: ${left.slice(0, 10).join(', ')}${left.length > 10 ? '…' : ''}. ` : '') +
  `Desmarque no plano os passos desfeitos (do ${n} em diante) e pare. ${NO_GUI}`;

export const APPROVE_PROMPT = 'Plano aprovado, pode seguir. A cada passo concluído, marque `- [x]` no arquivo do plano.';

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
