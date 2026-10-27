// Run history per automação: historico.jsonl (one line per run) plus a
// markdown report per run. Reports are only ever read back as text: nothing
// in them is executed. IO injected (an fs-like object).
import { join } from 'node:path';

export const KEEP_RUNS = 100;
const REPORT_NAME = /^\d{8}-\d{4}(?:-\d+)?\.md$/;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
// An id is a path segment: refuse anything that could climb out of dir.
const safeId = (id) => typeof id === 'string' && /^[\w-]+$/.test(id);

export function createHistory({ dir, fs, now = () => new Date(), keep = KEEP_RUNS }) {
  const folder = (id) => join(dir, id);
  const logFile = (id) => join(folder(id), 'historico.jsonl');

  const readEntries = async (id) => {
    let text = '';
    try { text = await fs.readFile(logFile(id), 'utf8'); } catch { return []; }
    return text.split('\n').flatMap((line) => {
      try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
    });
  };

  const report = (entry) => [
    `# ${entry.name ?? entry.id ?? 'Automação'}`,
    '',
    `- Status: ${entry.status}`,
    `- Custo: US$ ${Number(entry.costUsd ?? 0).toFixed(2)}`,
    `- Duração: ${Math.round((entry.durationMs ?? 0) / 1000)} s`,
    ...(entry.late ? ['- Atrasada: sim'] : []),
    ...(entry.branch ? [`- Branch: ${entry.branch}`] : []),
    '',
    String(entry.result ?? entry.reason ?? '(sem resultado)'),
    '',
  ].join('\n');

  return {
    async append(id, entry) {
      if (!safeId(id)) throw new Error('invalid automação id');
      await fs.mkdir(folder(id), { recursive: true });
      const at = now();
      const base = stamp(at);
      let name = `${base}.md`;
      for (let n = 2; ; n++) {
        try { await fs.readFile(join(folder(id), name), 'utf8'); } catch { break; }
        name = `${base}-${n}.md`;
      }
      await fs.writeFile(join(folder(id), name), report({ ...entry, id }));
      const saved = { ...entry, at: at.toISOString(), report: name };
      delete saved.result; // the report holds the text; the log stays small
      await fs.appendFile(logFile(id), `${JSON.stringify(saved)}\n`);
      const all = await readEntries(id);
      if (all.length > keep) {
        const dropped = all.slice(0, all.length - keep);
        await fs.writeFile(logFile(id), all.slice(-keep).map((e) => JSON.stringify(e)).join('\n') + '\n');
        for (const e of dropped) {
          if (typeof e.report === 'string' && REPORT_NAME.test(e.report)) {
            try { await fs.rm(join(folder(id), e.report), { force: true }); } catch { /* already gone */ }
          }
        }
      }
      return saved;
    },
    // Newest first.
    async list(id, { limit = 20 } = {}) {
      if (!safeId(id)) return [];
      return (await readEntries(id)).reverse().slice(0, limit);
    },
    async read(id, file) {
      if (!safeId(id) || typeof file !== 'string' || !REPORT_NAME.test(file)) return null;
      try { return await fs.readFile(join(folder(id), file), 'utf8'); } catch { return null; }
    },
  };
}
