import { renderHistory, renderReview, renderStatus } from './rules-view.js';

const COMPILE_ERRORS = {
  'sem-orcamento': 'Sem orçamento de tokens hoje. Suba o limite em Configurações › limites.',
  'sem-claude': 'Não consegui rodar o claude pra compilar.',
  'resposta-invalida': 'A resposta do gerente veio quebrada. Tente de novo.',
};

const $ = (id) => document.getElementById(id);
let state = null;
let current = 'global';
// What the textarea held when it was last loaded or saved: an unsaved edit
// survives a refresh pushed by the main process.
let loadedText = null;

function scopeOf(key) {
  return state?.scopes.find((scope) => scope.scope === key) ?? state?.scopes[0] ?? null;
}

function say(text) {
  $('message').textContent = text ?? '';
}

function render() {
  if (!state) return;
  const scope = scopeOf(current);
  current = scope.scope;
  $('status').innerHTML = renderStatus(state.status);
  $('enabled').checked = state.status.enabled;
  $('scopes').replaceChildren(
    ...state.scopes.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.title = item.file;
      button.classList.toggle('active', item.scope === current);
      button.classList.toggle('waiting', item.pending.length > 0 || !item.compiled);
      button.addEventListener('click', () => {
        if (dirty() && !confirm('Descartar o que você não salvou?')) return;
        current = item.scope;
        loadedText = null;
        render();
      });
      return button;
    }),
  );
  $('file').textContent = scope.compiled ? scope.file : `${scope.file} — de fora; nada vale até você compilar e aprovar`;
  if (loadedText === null || !dirty()) {
    $('editor').value = scope.markdown;
    loadedText = scope.markdown;
  }
  $('review').innerHTML = renderReview(scope);
  if (scope.compiling) say('O gerente está traduzindo as linhas novas…');
  else if (scope.compileError) say(COMPILE_ERRORS[scope.compileError] ?? scope.compileError);
  else if ($('message').textContent.startsWith('O gerente está traduzindo')) say('Pronto: revise as traduções abaixo.');
  $('history').innerHTML = renderHistory(state.history);
}

function dirty() {
  return loadedText !== null && $('editor').value !== loadedText;
}

async function refresh() {
  state = await window.rules.state();
  render();
}

$('save').addEventListener('click', async () => {
  const text = $('editor').value;
  state = await window.rules.save(current, text);
  loadedText = text;
  say('Salvo. O gerente está traduzindo as linhas novas…');
  render();
});

$('compile').addEventListener('click', async () => {
  if (dirty()) {
    say('Salve antes de compilar.');
    return;
  }
  say('Compilando…');
  $('compile').disabled = true;
  try {
    const result = await window.rules.compile(current);
    if (result.error) say(COMPILE_ERRORS[result.error] ?? result.error);
    else {
      state = result.state;
      say(result.compiled ? `${result.compiled} para revisar.` : 'Nada pendente.');
      render();
    }
  } finally {
    $('compile').disabled = false;
  }
});

$('enabled').addEventListener('change', async (event) => {
  state = await window.rules.setEnabled(event.target.checked);
  render();
});

for (const button of document.querySelectorAll('[data-template]')) {
  button.addEventListener('click', () => {
    const editor = $('editor');
    const prefix = editor.value && !editor.value.endsWith('\n') ? '\n' : '';
    editor.value += `${prefix}- ${button.dataset.template}\n`;
    editor.focus();
  });
}

$('review').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-rule-action]');
  if (!button) return;
  const { ruleAction: action, ruleId: id } = button.dataset;
  const item = button.closest('.rule');
  if (action === 'approve') {
    const edited = item.querySelector('textarea');
    let rule = null;
    if (edited) {
      try {
        rule = JSON.parse(edited.value);
      } catch {
        say('A tradução editada não é um JSON válido.');
        return;
      }
    }
    state = await window.rules.approve(current, id, rule);
    say(state.error ? 'Essa edição não vira uma trava válida — confira os tipos e campos.' : '');
    render();
  } else if (action === 'discard') {
    state = await window.rules.discard(current, id);
    render();
  } else if (action === 'edit' && !item.querySelector('textarea')) {
    // The audience reads JSON: edit the check itself, then aprovar.
    const draft = scopeOf(current).drafts.find((rule) => rule.id === id);
    const editor = document.createElement('textarea');
    editor.spellcheck = false;
    editor.value = JSON.stringify({ kind: draft.kind, irreversible: draft.irreversible, explain: draft.explain, match: draft.match }, null, 2);
    item.append(editor);
  }
});

async function runTest() {
  const command = $('test-command').value.trim();
  if (!command) return;
  const result = await window.rules.test(current, command);
  $('test-result').textContent = result
    ? `${result.kind === 'forbid' ? 'Barrado' : 'Pergunta antes'}: "${result.source}" — ${result.explain}`
    : 'Passa: nenhuma regra pega esse comando.';
}
$('test').addEventListener('click', runTest);
$('test-command').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runTest();
});

window.rules.onChanged(refresh);
refresh();
