// The automações themselves: field validation plus a small JSON store
// (~/.config/vizor/automacoes.json) written atomically. IO is injected.
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseWhen } from './schedule.js';

const LEVELS = ['read', 'worktree', 'project'];
const MODELS = ['haiku', 'sonnet', 'opus'];
const MISSED = ['run', 'skip'];
const SCOPES = ['personal', 'project'];
export const MAX_SLUG = 40;

export function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'automacao';
}

const fail = (error) => ({ ok: false, error });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (list, v, dflt) => (v === undefined ? dflt : list.includes(v) ? v : undefined);

export function validateAutomation(raw, { now = Date.now, newId = randomUUID } = {}) {
  if (!raw || typeof raw !== 'object') return fail('Automação inválida.');
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return fail('Dê um nome à automação.');
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return fail('Escreva o que a automação deve fazer.');
  if (typeof raw.projectRoot !== 'string' || !raw.projectRoot.startsWith('/') || raw.projectRoot.split('/').includes('..')) return fail('Escolha a pasta do projeto.');
  const projectRoot = resolve(raw.projectRoot);
  const when = parseWhen(raw.when);
  if (when.error) return fail(when.error);
  const slug = raw.slug === undefined ? slugify(name) : raw.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > MAX_SLUG) return fail('Apelido da skill inválido.');
  const level = oneOf(LEVELS, raw.level, 'read');
  if (!level) return fail('Nível de permissão inválido.');
  const model = oneOf(MODELS, raw.model, 'sonnet');
  if (!model) return fail('Modelo inválido.');
  const capUsd = raw.capUsd === undefined ? 1 : raw.capUsd;
  if (!isNum(capUsd) || capUsd < 0.05 || capUsd > 20) return fail('O teto deve ficar entre US$ 0,05 e US$ 20.');
  const timeoutMin = raw.timeoutMin === undefined ? 15 : raw.timeoutMin;
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 60) return fail('O tempo limite deve ficar entre 1 e 60 min.');
  const missed = oneOf(MISSED, raw.missed, 'run');
  if (!missed) return fail('Opção de horário perdido inválida.');
  const skillScope = oneOf(SCOPES, raw.skillScope, 'personal');
  if (!skillScope) return fail('Escopo da skill inválido.');
  const lastRun = raw.lastRun ?? null;
  if (lastRun !== null && !isNum(lastRun)) return fail('Última execução inválida.');
  const createdAt = raw.createdAt ?? now();
  if (!isNum(createdAt)) return fail('Data de criação inválida.');
  const id = raw.id ?? newId();
  if (typeof id !== 'string' || !id) return fail('Identificador inválido.');
  return {
    ok: true,
    automation: {
      id, name, slug, prompt: raw.prompt, projectRoot, when,
      level, model, capUsd, timeoutMin, missed, skillScope,
      paused: raw.paused === true, blockedUntilConfirm: raw.blockedUntilConfirm === true,
      createdAt, lastRun,
    },
  };
}

function uniqueSlug(slug, items) {
  const taken = new Set(items.map((x) => x.slug));
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug.slice(0, MAX_SLUG - String(n).length - 1).replace(/-+$/, '')}-${n}`;
  return out;
}

export function createAutomationStore({ file, readFile, writeFile, rename, mkdir, log, onError, now = Date.now }) {
  let items = null; // loaded lazily, then the source of truth
  let readError = null; // a non-ENOENT read failure: nothing may be written over the file
  let chain = Promise.resolve(); // every operation runs one at a time: they share the tmp file

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      items = [];
      if (error?.code !== 'ENOENT') {
        readError = error;
        log?.(`automations: could not read ${file}, starting empty (${error.message})`);
      }
      return;
    }
    // A bad file is moved aside, never overwritten by the next save.
    const backup = `${file}.corrupt-${now()}`;
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data?.automations)) throw new Error('unexpected shape');
      items = [];
      let dropped = 0;
      for (const raw of data.automations) {
        const r = validateAutomation(raw);
        if (r.ok) items.push(r.automation); else { dropped++; log?.(`automations: dropped an invalid entry (${r.error})`); }
      }
      if (dropped) await writeFile(backup, text).catch((e) => log?.(`automations: could not back up ${file} (${e.message})`));
    } catch (error) {
      items = [];
      log?.(`automations: ${file} is corrupt, moved to ${backup} (${error.message})`);
      await rename(file, backup).catch((e) => log?.(`automations: could not back up ${file} (${e.message})`));
    }
  }

  async function persist(next) {
    // The file exists but could not be read: writing would erase what it holds.
    if (readError) throw new Error(`automations: refusing to overwrite unreadable ${file}`);
    const tmp = `${file}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify({ automations: next }, null, 2));
      await rename(tmp, file);
    } catch (error) {
      onError?.(error);
      throw error;
    }
    items = next; // memory only moves once the disk has it
  }

  const run = (fn) => {
    const result = chain.then(async () => { if (items === null) await load(); return fn(); });
    chain = result.catch(() => {});
    return result;
  };

  const upsert = async (a) => {
    const r = validateAutomation(a);
    if (!r.ok) return r;
    const i = items.findIndex((x) => x.id === r.automation.id);
    // The slug names the skill folder (and removeSkill deletes it), so it is
    // unique across automações and never changes once assigned.
    const slug = i >= 0 ? items[i].slug : uniqueSlug(r.automation.slug, items);
    const automation = { ...r.automation, slug };
    const next = [...items];
    if (i >= 0) next[i] = automation; else next.push(automation);
    await persist(next);
    return { ok: true, automation: structuredClone(automation) };
  };

  return {
    // The load's error when the file exists but could not be read, else null.
    readError: () => run(() => readError),
    list: () => run(() => structuredClone(items)),
    get: (id) => run(() => structuredClone(items.find((x) => x.id === id) ?? null)),
    save: (a) => run(() => upsert(a)),
    patch: (id, partial) => run(async () => {
      const cur = items.find((x) => x.id === id);
      if (!cur) return fail('Automação não encontrada.');
      return upsert({ ...cur, ...partial, id });
    }),
    remove: (id) => run(async () => {
      if (!items.some((x) => x.id === id)) return false;
      await persist(items.filter((x) => x.id !== id));
      return true;
    }),
  };
}
