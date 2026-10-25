// Pure renderers of the rules window (#160): status line, review list and
// history. Rule text is the user's (or a cloned repo's) — always escaped.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const KIND = { forbid: 'proibido', ask: 'perguntar', agent: 'pros agentes · sem trava' };
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function renderStatus(status) {
  const off = !status.enabled || status.unreadable;
  const label = off ? 'trava desligada' : 'trava ligada';
  const why = status.unreadable ? ' — o arquivo das regras está ilegível' : !status.enabled ? ' — desligada nas configurações' : '';
  const parts = [
    `<span class="status-dot${off ? ' status-off' : ''}"></span><strong>${label}</strong>${why}`,
    plural(status.active ?? 0, 'ativa', 'ativas'),
    plural(status.pending ?? 0, 'esperando revisão', 'esperando revisão'),
  ];
  const warning =
    status.enabled && status.installed && status.offline === false
      ? '<div class="status-warn">Neste formato (AppImage sem node) a trava só funciona com o Vizor aberto.</div>'
      : '';
  return `<div class="status${off ? ' status-off' : ''}">${parts.join(' · ')}</div>${warning}`;
}

function chips(rule) {
  return [
    `<span class="chip kind-${escape(rule.kind)}">${KIND[rule.kind] ?? KIND.agent}</span>`,
    rule.irreversible ? '<span class="chip chip-warn">sem volta</span>' : '',
  ].join('');
}

function draftItem(rule) {
  const id = escape(rule.id);
  const action = (name, label) => `<button type="button" data-rule-action="${name}" data-rule-id="${id}">${label}</button>`;
  return [
    `<li class="rule draft" data-rule-id="${id}">`,
    `<div class="rule-source">${escape(rule.source)}</div>`,
    `<div class="rule-meaning">entendi assim: ${escape(rule.explain || '—')} ${chips(rule)}</div>`,
    // A refused translation (risky regex) only leaves through an edit.
    rule.refused ? `<div class="rule-refused">${escape(rule.refused)} — edite a checagem antes de aprovar</div>` : '',
    `<div class="rule-actions">${rule.refused ? '' : action('approve', 'aprovar')}${action('edit', 'editar')}${action('discard', 'descartar')}</div>`,
    '</li>',
  ].join('');
}

function approvedItem(rule) {
  return `<li class="rule approved"><div class="rule-source">${escape(rule.source)}</div><div class="rule-meaning">${escape(rule.explain || '')} ${chips(rule)}</div></li>`;
}

export function renderReview(scope) {
  const waiting = scope.pending?.length ?? 0;
  const banner = waiting ? `<div class="banner">${plural(waiting, 'regra esperando revisão', 'regras esperando revisão')}</div>` : '';
  const drafts = scope.drafts?.length ? `<h3>Para revisar</h3><ul>${scope.drafts.map(draftItem).join('')}</ul>` : '';
  const approved = scope.approved?.length
    ? `<h3>Valendo</h3><ul>${scope.approved.map(approvedItem).join('')}</ul>`
    : '<p class="empty">Nenhuma regra valendo aqui ainda.</p>';
  return `${banner}${drafts}${approved}`;
}

export function renderHistory(items) {
  if (!items.length) return '<p class="empty">nada barrado nem perguntado ainda</p>';
  const row = (item) => {
    const when = new Date(item.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    return `<li><span class="when">${escape(when)}</span> <span class="outcome">${escape(item.outcome)}</span> <code>${escape(item.summary)}</code> <span class="rule-ref">${escape(item.ruleSource)}</span></li>`;
  };
  return `<ul class="history">${items.map(row).join('')}</ul>`;
}
