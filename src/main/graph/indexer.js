import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { linkGraph } from './link.js';

// The Maestro graph of one project (#159): the JS/TS files git knows, parsed
// once and again only when they change (mtime + size, or a músico's edit via
// touch), linked into modules and calls. Every fs and parse call is injected.
const SOURCE = /\.(m|c)?(j|t)sx?$/;
const LEFT_OUT = /(^|\/)(node_modules|dist)\/|\.min\.js$/;
export const GRAPH_LIMITS = { maxFiles: 3000, maxBytes: 300 * 1024 };

export function createGraphIndexer(options) {
  const { listFiles, statFile, readFile, parse, limits = GRAPH_LIMITS } = options;
  const indexer = new EventEmitter();
  const cache = new Map(); // relPath → { key, extract }
  const dirty = new Set();
  let current = null;
  let running = null;
  let again = false;

  async function build() {
    let listed;
    try {
      listed = await listFiles();
    } catch {
      return { unavailable: 'sem git neste projeto' };
    }
    const sources = listed.filter((relPath) => SOURCE.test(relPath) && !LEFT_OUT.test(relPath)).sort();
    const files = [];
    for (const relPath of sources) {
      const stat = await statFile(relPath).catch(() => null);
      if (stat && stat.size <= limits.maxBytes) files.push({ relPath, key: `${stat.mtimeMs}:${stat.size}` });
    }
    if (!files.length) return { unavailable: 'nenhum arquivo JS/TS neste projeto' };
    const kept = files.slice(0, limits.maxFiles);
    let changed = current === null || current.unavailable !== undefined || current.truncated !== files.length > kept.length;
    const keep = new Set(kept.map((file) => file.relPath));
    for (const relPath of [...cache.keys()])
      if (!keep.has(relPath)) {
        cache.delete(relPath);
        changed = true;
      }
    for (const { relPath, key } of kept) {
      const cached = cache.get(relPath);
      if (cached && cached.key === key && !dirty.has(relPath)) continue;
      dirty.delete(relPath);
      const source = await readFile(relPath).catch(() => '');
      cache.set(relPath, { key, extract: await parse(source, relPath) });
      changed = true;
    }
    if (!changed) return current;
    const graph = linkGraph(new Map([...cache].map(([relPath, { extract }]) => [relPath, extract])));
    return { ...graph, truncated: files.length > kept.length };
  }

  // After an edit: only the touched files are read and parsed again, no
  // listing and no stat of the rest — every edit used to cost the whole repo
  // (review I2). The next full refresh still catches files added elsewhere.
  async function rebuildTouched() {
    if (!current || current.unavailable) return build();
    const touched = [...dirty];
    dirty.clear();
    for (const relPath of touched) {
      const stat = await statFile(relPath).catch(() => null);
      if (!stat || stat.size > limits.maxBytes || !SOURCE.test(relPath) || LEFT_OUT.test(relPath)) {
        cache.delete(relPath);
        continue;
      }
      if (!cache.has(relPath) && cache.size >= limits.maxFiles) continue;
      const source = await readFile(relPath).catch(() => '');
      cache.set(relPath, { key: `${stat.mtimeMs}:${stat.size}`, extract: await parse(source, relPath) });
    }
    if (!touched.length) return current;
    const graph = linkGraph(new Map([...cache].map(([relPath, { extract }]) => [relPath, extract])));
    return { ...graph, truncated: current.truncated };
  }

  // One refresh at a time; a touch during one runs another right after. A
  // failed one never blocks the next (review M2).
  function run(work) {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        let result;
        do {
          again = false;
          result = await work();
          if (result !== current) {
            current = result;
            indexer.emit('graph', current);
          }
        } while (again);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  indexer.refresh = () => run(build);
  indexer.refreshTouched = () => run(rebuildTouched);

  indexer.touch = (relPath) => {
    dirty.add(relPath);
  };
  indexer.graph = () => current;
  indexer.options = options;
  return indexer;
}

// The production parse: one worker for the app, a queue of files, 5 s each.
// A file that takes longer is left with only its top level.
const PARSE_TIMEOUT_MS = 5000;
// A worker that dies (crash, out of memory) answers what it had with the top
// level only and is born again on the next parse (review M1): never an
// uncaught error in main, never 5 s per file forever.
const topOnly = (source, relPath, error) => ({
  functions: [{ id: `${relPath}#<topo>`, name: '<topo>', startLine: 1, endLine: String(source).split('\n').length }],
  imports: [],
  calls: [],
  error,
});

export function createWorkerParser() {
  const waiting = new Map(); // id → { resolve, timer, source, relPath }
  let worker = null;
  let serial = 0;

  const settle = (id, extract) => {
    const entry = waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(id);
    entry.resolve(extract ?? topOnly(entry.source, entry.relPath, 'worker gone'));
  };

  function ensure() {
    if (worker) return worker;
    const born = new Worker(new URL('./graph-worker.js', import.meta.url));
    born.unref();
    born.on('message', ({ id, extract }) => settle(id, extract));
    const died = () => {
      if (worker !== born) return;
      worker = null;
      for (const id of [...waiting.keys()]) settle(id, null);
    };
    born.on('error', died);
    born.on('exit', died);
    worker = born;
    return born;
  }

  return {
    parse(source, relPath) {
      const id = ++serial;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, topOnly(source, relPath, 'timeout')), PARSE_TIMEOUT_MS);
        waiting.set(id, { resolve, timer, source, relPath });
        ensure().postMessage({ id, source, relPath });
      });
    },
    worker: ensure,
    close: () => {
      const closing = worker;
      worker = null;
      for (const id of [...waiting.keys()]) settle(id, null);
      return closing?.terminate();
    },
  };
}
