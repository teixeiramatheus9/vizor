// The rule guard's question card (#160), shared by the bubble's panel and the
// workspace. Everything in an ask came from a hook: escape it all.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const baseName = (file) => String(file ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

// "a automação PRs da manhã", or a generic one if the name is gone.
const automationLabel = (ask) => (ask.automationName ? `a automação ${ask.automationName}` : 'uma automação');

export function renderGuardCard(ask) {
  const id = escape(ask.id);
  const button = (choice, label) =>
    `<button type="button" class="guard-choice guard-${choice}" data-guard-id="${id}" data-guard-choice="${choice}">${label}</button>`;
  return [
    `<div class="guard-card${ask.irreversible ? ' irreversible' : ''}" data-guard-card="${id}">`,
    `<div class="guard-head"><span class="guard-title">${ask.automationId ? `${escape(automationLabel(ask))} quer…` : 'Posso seguir?'}</span><span class="guard-project">${escape(baseName(ask.cwd))}</span></div>`,
    `<code class="guard-call">${escape(ask.summary)}</code>`,
    `<div class="guard-rule">regra: ${escape(ask.ruleSource)}</div>`,
    ask.explain ? `<div class="guard-explain">${escape(ask.explain)}</div>` : '',
    ask.irreversible ? '<div class="guard-hint">isso não tem volta — pergunto sempre</div>' : '',
    '<div class="guard-actions">',
    button('liberar', 'Liberar'),
    // An automação's step is freed once at a time (spec: automações, item 6).
    ask.irreversible || ask.automationId ? '' : button('liberar-sessao', 'Liberar nesta sessão'),
    button('barrar', 'Barrar'),
    '</div>',
    '</div>',
  ].join('');
}

// lang follows the voice: an English voice asks in English.
export function guardSpeech(ask, lang = 'pt') {
  const file = baseName(ask.summary.split(' ').slice(1).join(' ')) || ask.tool;
  if (lang === 'en') {
    const what = ask.tool === 'Bash' ? `run ${ask.summary}` : `edit ${file}`;
    return `A Claude in ${baseName(ask.cwd) || 'a project'} wants to ${what}. Can I go ahead?`;
  }
  if (ask.automationId) return `${automationLabel(ask)} quer ${ask.tool === 'Bash' ? `rodar ${ask.summary}` : `mexer em ${file}`}. Posso seguir?`.replace(/^./, (c) => c.toUpperCase());
  const project = baseName(ask.cwd) || 'um projeto';
  const what = ask.tool === 'Bash' ? `rodar ${ask.summary}` : `mexer em ${file}`;
  return `Um Claude no ${project} quer ${what}. Posso seguir?`;
}
