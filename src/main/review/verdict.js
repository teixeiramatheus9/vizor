// The verdict strip above the review: one short, honest line per signal. A
// signal that was not measured says so instead of showing a green tick.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function tscItem(tsc) {
  if (tsc?.status === 'running') return { key: 'tsc', text: 'tsc: rodando…', tone: 'muted' };
  if (tsc?.status === 'ok') return { key: 'tsc', text: 'tsc ✓', tone: 'ok' };
  if (tsc?.status === 'fail') {
    // The list keeps 500 errors; the rest are only counted, and errors in
    // files outside the worktree (a linked package) count apart.
    const count = (tsc.errors?.length ?? 0) + (tsc.omitted ?? 0);
    const outside = tsc.outside ?? 0;
    // A failed run whose output had no error line we could read proves nothing.
    if (count === 0 && outside === 0) return { key: 'tsc', text: 'tsc: não verificado (saída sem erros legíveis)', tone: 'warn' };
    const extra = outside > 0 ? ` +${outside} fora do worktree` : '';
    return { key: 'tsc', text: `tsc: ${plural(count, 'erro', 'erros')}${extra}`, tone: 'bad' };
  }
  const reason = tsc?.reason ?? (tsc?.status === 'timeout' ? 'tempo esgotado' : null);
  return { key: 'tsc', text: reason ? `tsc: não verificado (${reason})` : 'tsc: não verificado', tone: 'muted' };
}

function testsItem(tests) {
  if (tests?.status === 'running') return { key: 'tests', text: 'testes: rodando…', tone: 'muted' };
  if (tests?.status === 'ok') return { key: 'tests', text: 'testes ✓', tone: 'ok' };
  if (tests?.status === 'fail' || tests?.status === 'timeout') return { key: 'tests', text: 'testes ✗', tone: 'bad' };
  return { key: 'tests', text: 'testes: não rodados', tone: 'muted' };
}

export function buildVerdict({ files = [], tsc, tests, untestedChanged = 0, contract = 0, contractPending = false, approved = 0, totalHunks = 0 }) {
  const added = files.reduce((sum, f) => sum + (f.added || 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.removed || 0), 0);
  const items = [
    { key: 'files', text: `${plural(files.length, 'arquivo', 'arquivos')} (+${added} −${removed})`, tone: 'muted' },
    tscItem(tsc),
    testsItem(tests),
  ];
  if (untestedChanged > 0) {
    items.push({ key: 'untested', text: `${plural(untestedChanged, 'função alterada', 'funções alteradas')} sem teste por perto`, tone: 'warn' });
  }
  if (contractPending) {
    items.push({ key: 'contract', text: 'contrato: analisando…', tone: 'muted' });
  } else if (contract > 0) {
    items.push({ key: 'contract', text: plural(contract, 'mudança de contrato', 'mudanças de contrato'), tone: 'warn' });
  }
  items.push({ key: 'review', text: `revisado ${approved}/${totalHunks} hunks`, tone: totalHunks > 0 && approved >= totalHunks ? 'ok' : 'muted' });
  return items;
}
