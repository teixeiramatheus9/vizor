// The Ctrl+K bar: the core flow by keyboard, the same actions the voice has.
// Typed is meant, so nothing here is held or spoken. Pure: workspace.js opens
// it, asks main for the issues and PRs and runs the chosen action.
import { escapeHtml } from './workspace-view.js';

const fold = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

// chats: [{ sessionId, name, status }]; plans: sessionId → { steps, approved }.
export function buildCommands({ issues = [], prs = [], chats = [], plans = {}, focusedId = null, maestroOn = false, issuesError = false, prsError = false, issuesLoading = false } = {}) {
  const items = [];
  const focused = chats.find((chat) => chat.sessionId === focusedId);
  const plan = focused && plans[focused.sessionId];
  if (plan?.steps?.length && !plan.approved)
    items.push({ id: `approve:${focused.sessionId}`, group: 'Plano', label: `Aprovar o plano de ${focused.name}`, action: { type: 'approve', sessionId: focused.sessionId } });
  else if (plan?.steps?.length && plan.steps.every((step) => step.done))
    items.push({ id: `pr:${focused.sessionId}`, group: 'Plano', label: `Abrir a PR de ${focused.name}`, action: { type: 'open-pr', sessionId: focused.sessionId } });
  for (const issue of issues)
    items.push({ id: `issue:${issue.number}`, group: 'Issues', label: `Puxar #${issue.number} ${issue.title}`, number: issue.number, action: { type: 'pick-issue', number: issue.number } });
  if (issuesLoading) items.push({ id: 'issues-loading', group: 'Issues', label: 'carregando as issues…', disabled: true });
  if (issuesError) items.push({ id: 'issues-error', group: 'Issues', label: 'não deu pra ler as issues (gh)', disabled: true });
  for (const chat of chats) items.push({ id: `focus:${chat.sessionId}`, group: 'Chats', label: `Ir para ${chat.name}`, action: { type: 'focus', sessionId: chat.sessionId } });
  for (const chat of chats.filter((item) => item.status === 'working'))
    items.push({ id: `interrupt:${chat.sessionId}`, group: 'Chats', label: `Interromper ${chat.name}`, action: { type: 'interrupt', sessionId: chat.sessionId } });
  for (const pr of prs) items.push({ id: `review:${pr.number}`, group: 'PRs', label: `Revisar PR #${pr.number} ${pr.title}`, action: { type: 'review-pr', number: pr.number } });
  if (prsError) items.push({ id: 'prs-error', group: 'PRs', label: 'não consegui ler as PRs', disabled: true });
  for (const [tab, name] of [['workspace', 'Workspace'], ['agents', 'Agentes'], ['github', 'GitHub']])
    items.push({ id: `tab:${tab}`, group: 'Telas', label: `Ir pra ${name}`, action: { type: 'goto-tab', tab } });
  items.push({ id: 'maestro', group: 'Vizor', label: maestroOn ? 'Desligar o Maestro' : 'Ligar o Maestro', action: { type: 'maestro', on: !maestroOn } });
  return items;
}

// Every word must match; a bare number ("169", "#169") puts its issue first.
export function filterCommands(items, query) {
  const words = fold(query).split(/\s+/).map((word) => word.replace(/^#/, '')).filter(Boolean);
  if (!words.length) return items;
  const found = items.filter((item) => words.every((word) => fold(item.label).includes(word)));
  const number = words.length === 1 && /^\d+$/.test(words[0]) ? Number(words[0]) : null;
  if (number === null) return found;
  return [...found.filter((item) => item.number === number), ...found.filter((item) => item.number !== number)];
}

export function renderCommandList(items, selected) {
  if (!items.length) return '<li class="command-empty">nada encontrado</li>';
  return items
    .map(
      (item, index) =>
        `<li class="command-item${item.disabled ? ' disabled' : ''}" data-command-index="${index}"${index === selected ? ' aria-selected="true"' : ''}><span class="command-group">${escapeHtml(
          item.group,
        )}</span>${escapeHtml(item.label)}</li>`,
    )
    .join('');
}
