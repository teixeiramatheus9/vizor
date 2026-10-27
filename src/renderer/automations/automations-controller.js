// The Automações tab: draws the list, the form and the history, and wires the
// actions. No globals: the DOM regions, the IPC api and the clock come in, so
// vitest drives it with fakes. Nothing reads or ticks while the tab is hidden;
// the "rodando há N min" clock is one 1 s setTimeout, only while a run exists.
import { PRESETS, blankForm, formFromAutomation, renderForm, renderHistory, renderList, renderSideEmpty, renderTop, validateForm, worktreeOf } from './automations-view.js';

export const CLOCK_MS = 1000;

const isTextual = (node) => node?.tagName === 'TEXTAREA' || (node?.tagName === 'INPUT' && !['radio', 'checkbox'].includes(node.type));
const num = (text) => (String(text ?? '').trim() === '' ? NaN : Number(String(text).replace(',', '.')));

// deps:
//   el, regions   el takes the events; regions = { top, list, side } hold the html
//   api           the automations* calls of the workspace preload
//   projects()    root -> { name, uri, accent }
//   openReview(worktreePath)   the Workspace tab on that worktree
//   notify(text)  a short message for the user
export function createAutomationsController({
  el,
  regions,
  api,
  projects = () => ({}),
  openReview = () => {},
  notify = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  let data = null; // the service's state()
  let visible = false;
  let timer = null;
  let seq = 0; // the newest history read; an older answer is dropped
  const ui = { capEditing: false, capError: null, deleting: null, dropSkill: false, dropWorktree: false, error: null, improving: false, improveError: null, saveError: null };
  // side: null | { mode: 'form', form } | { mode: 'history', id, runs, report }
  let side = null;
  let formRev = 0; // a state push must not redraw the form under the user's fingers
  const last = { top: null, list: null, side: null, sideKey: null };

  const list = () => data?.list ?? [];
  const find = (id) => list().find((a) => a.id === id) ?? null;
  const guardEnabled = () => data?.guardEnabled !== false;
  const readError = () => data?.readError ?? null;

  function put(name, html) {
    if (last[name] === html) return false;
    last[name] = html;
    regions[name].innerHTML = html;
    return true;
  }

  function drawTop() {
    put('top', renderTop({ budget: data?.budget ?? null, readError: readError(), ui }));
  }

  function drawList() {
    put('list', renderList(list(), { projects: projects(), now: now(), ui, readError: readError(), selectedId: side?.mode === 'history' ? side.id : null, loading: !data }));
  }

  function drawSide() {
    if (!side) {
      last.sideKey = null;
      put('side', renderSideEmpty());
      return;
    }
    if (side.mode === 'form') {
      const key = `form:${formRev}`;
      if (last.sideKey === key) return;
      last.sideKey = key;
      last.side = null;
      put('side', renderForm(side.form, { projects: projects(), guardEnabled: guardEnabled(), readError: readError(), ui }));
      return;
    }
    last.sideKey = null;
    const automation = find(side.id);
    put('side', automation ? renderHistory({ automation, runs: side.runs, report: side.report, now: now() }) : renderSideEmpty());
  }

  function render() {
    if (!visible) return;
    drawTop();
    drawList();
    drawSide();
    schedule();
  }

  // The form changed shape (a select, a preset): draw it again.
  function redrawForm() {
    formRev++;
    render();
  }

  // Live validation without redrawing: the typed text keeps its focus.
  function refreshValidation() {
    if (side?.mode !== 'form' || !regions.side.querySelectorAll) return;
    const { errors } = validateForm(side.form, { guardEnabled: guardEnabled(), projects: projects() });
    for (const node of regions.side.querySelectorAll('[data-au-error]')) {
      const text = errors[node.dataset.auError] ?? '';
      node.textContent = text;
      node.closest?.('.au-field')?.classList.toggle('invalid', Boolean(text));
    }
    const save = regions.side.querySelector('[data-au-action="save"]');
    if (save) save.disabled = Object.keys(errors).length > 0 || Boolean(readError());
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  // One timeout, set again after each tick, only while a run is going.
  function schedule() {
    cancelTimer();
    if (!visible || !list().some((a) => a.running)) return;
    timer = setTimer(() => {
      timer = null;
      if (!visible) return;
      drawList();
      schedule();
    }, CLOCK_MS);
  }

  async function load() {
    try {
      data = (await api.automationsState()) ?? data;
    } catch {
      /* the next push or visit tries again */
    }
    render();
  }

  async function loadHistory(id) {
    const mine = ++seq;
    let runs = [];
    try {
      runs = (await api.automationsHistory(id)) ?? [];
    } catch {
      runs = [];
    }
    if (mine !== seq || side?.mode !== 'history' || side.id !== id) return;
    side.runs = runs;
    const newest = side.report && runs.some((run) => run.report === side.report.file) ? side.report.file : runs[0]?.report;
    render();
    if (newest) await openReport(id, newest);
  }

  async function openReport(id, file) {
    const mine = ++seq;
    let text = null;
    try {
      text = await api.automationsReport(id, file);
    } catch {
      text = null;
    }
    if (mine !== seq || side?.mode !== 'history' || side.id !== id) return;
    side.report = { file, text };
    render();
  }

  // An answer from main: { ok:false, error } becomes the item's message.
  async function act(id, call) {
    ui.error = null;
    let result;
    try {
      result = await call();
    } catch {
      result = { ok: false, error: 'não deu pra falar com o Vizor' };
    }
    if (result && result.ok === false) ui.error = { id, text: result.error ?? 'não deu certo' };
    await load();
    return result;
  }

  async function save() {
    if (side?.mode !== 'form' || readError()) return;
    const { payload } = validateForm(side.form, { guardEnabled: guardEnabled(), projects: projects() });
    if (!payload) {
      refreshValidation();
      return;
    }
    ui.saveError = null;
    let result;
    try {
      result = await api.automationsSave(payload);
    } catch {
      result = { ok: false, error: 'não deu pra falar com o Vizor' };
    }
    if (result?.ok) {
      side = null;
      ui.saveError = null;
      await load();
      return;
    }
    ui.saveError = result?.error ?? 'Não deu pra gravar a automação.';
    redrawForm();
  }

  async function improve() {
    if (side?.mode !== 'form' || ui.improving) return;
    const form = side.form;
    if (!form.prompt.trim()) {
      ui.improveError = 'Escreva o pedido primeiro.';
      redrawForm();
      return;
    }
    ui.improving = true;
    ui.improveError = null;
    redrawForm();
    let result;
    try {
      result = await api.automationsImprove(form.prompt);
    } catch {
      result = { ok: false, error: 'O gerente não respondeu agora. Tente de novo.' };
    }
    ui.improving = false;
    if (side?.form !== form) return render();
    if (result?.ok && result.text) {
      form.original ??= form.prompt;
      form.prompt = result.text;
    } else {
      ui.improveError = result?.error ?? 'O gerente não respondeu agora. Tente de novo.';
    }
    redrawForm();
  }

  async function saveCap(text) {
    const usd = num(text);
    let result;
    try {
      result = await api.automationsSetDayCap(usd);
    } catch {
      result = { ok: false, error: 'não deu pra falar com o Vizor' };
    }
    if (result?.ok) {
      ui.capEditing = false;
      ui.capError = null;
      await load();
    } else {
      ui.capError = result?.error ?? 'Teto inválido.';
      render();
    }
  }

  function resetForm() {
    ui.improving = false;
    ui.improveError = null;
    ui.saveError = null;
  }

  function runAction(action, id) {
    switch (action) {
      case 'new':
        resetForm();
        side = { mode: 'form', form: blankForm(projects()) };
        return redrawForm();
      case 'edit': {
        const a = find(id);
        if (!a) return undefined;
        resetForm();
        side = { mode: 'form', form: formFromAutomation(a) };
        return redrawForm();
      }
      case 'save':
        return save();
      case 'improve':
        return improve();
      case 'undo-improve':
        if (side?.mode === 'form' && side.form.original != null) {
          side.form.prompt = side.form.original;
          side.form.original = null;
        }
        return redrawForm();
      case 'close-side':
        seq++;
        side = null;
        return render();
      case 'history':
        side = { mode: 'history', id, runs: null, report: null };
        render();
        return loadHistory(id);
      case 'review': {
        const a = find(id);
        const path = a && worktreeOf(a);
        if (path) openReview(path);
        return undefined;
      }
      case 'run':
        return act(id, () => api.automationsRun(id));
      case 'cancel':
        return act(id, async () => ((await api.automationsCancel(id)) === false ? { ok: false, error: 'ela já tinha terminado' } : { ok: true }));
      case 'pause':
        return act(id, () => api.automationsPause(id, !find(id)?.paused));
      case 'confirm':
        return act(id, () => api.automationsConfirm(id));
      case 'delete':
        Object.assign(ui, { deleting: id, dropSkill: false, dropWorktree: false, error: null });
        return render();
      case 'delete-cancel':
        ui.deleting = null;
        return render();
      case 'delete-confirm': {
        const options = { removeSkill: ui.dropSkill, removeWorktree: ui.dropWorktree };
        ui.deleting = null;
        if (side && (side.id === id || side.form?.id === id)) side = null;
        return act(id, async () => {
          const result = await api.automationsRemove(id, options);
          if (result?.ok && result.warnings?.length) notify(result.warnings.join(' '));
          return result;
        });
      }
      case 'cap-edit':
        Object.assign(ui, { capEditing: true, capError: null });
        return render();
      case 'cap-cancel':
        Object.assign(ui, { capEditing: false, capError: null });
        return render();
      default:
        return undefined;
    }
  }

  el.addEventListener('click', (event) => {
    const target = event.target;
    const button = target.closest?.('[data-au-action]');
    if (button) {
      event.preventDefault?.();
      runAction(button.dataset.auAction, button.dataset.id);
      return;
    }
    const preset = target.closest?.('[data-au-preset]');
    if (preset && side?.mode === 'form') {
      Object.assign(side.form, PRESETS[Number(preset.dataset.auPreset)]?.fields ?? {});
      redrawForm();
      return;
    }
    const run = target.closest?.('[data-au-run]');
    if (run && side?.mode === 'history' && run.dataset.auRun) openReport(run.dataset.id, run.dataset.auRun);
  });

  el.addEventListener('input', (event) => {
    const node = event.target.closest?.('[data-au-field]');
    if (!node || side?.mode !== 'form' || !isTextual(node)) return;
    side.form[node.dataset.auField] = node.value;
    refreshValidation();
  });

  el.addEventListener('change', (event) => {
    const target = event.target;
    const drop = target.closest?.('[data-au-drop]');
    if (drop) {
      ui[drop.dataset.auDrop === 'skill' ? 'dropSkill' : 'dropWorktree'] = Boolean(drop.checked);
      return;
    }
    if (side?.mode !== 'form') return;
    const day = target.closest?.('[data-au-day]');
    if (day) {
      const n = Number(day.dataset.auDay);
      const days = new Set(side.form.days);
      if (day.checked) days.add(n);
      else days.delete(n);
      side.form.days = [...days].sort((a, b) => a - b);
      refreshValidation();
      return;
    }
    const node = target.closest?.('[data-au-field]');
    if (!node) return;
    side.form[node.dataset.auField] = node.value;
    if (isTextual(node)) refreshValidation();
    else redrawForm();
  });

  el.addEventListener('submit', (event) => {
    event.preventDefault?.();
    const target = event.target;
    if (target.closest?.('[data-au-cap]')) {
      saveCap(target.closest('[data-au-cap]').querySelector?.('[data-au-cap-input]')?.value);
      return;
    }
    if (target.closest?.('[data-au-form]')) save();
  });

  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (ui.capEditing || ui.deleting) {
      event.stopPropagation();
      Object.assign(ui, { capEditing: false, capError: null, deleting: null });
      render();
    }
  });

  return {
    // A push from main (automations:changed) or the first read.
    setState(next) {
      if (!next) return;
      const before = side?.mode === 'history' ? find(side.id)?.last?.report : null;
      data = next;
      if (side?.mode === 'history') {
        const a = find(side.id);
        if (!a) side = null;
        else if (a.last?.report !== before && visible) loadHistory(side.id);
      }
      if (side?.mode === 'form' && side.form.id && !find(side.form.id)) side = null;
      render();
    },
    setVisible(next) {
      visible = Boolean(next);
      if (!visible) {
        cancelTimer();
        return;
      }
      last.top = last.list = last.side = last.sideKey = null;
      render();
      load();
    },
    load,
    refresh: render,
    list,
    hasTimer: () => timer !== null,
    // Ctrl+K: "nova automação" and "rodar <nome>".
    startNew: () => runAction('new'),
    runNow: (id) => runAction('run', id),
    guardEnabled,
  };
}
