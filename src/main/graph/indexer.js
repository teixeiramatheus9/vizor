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

  // One refresh at a time; a touch during one runs another right after.
  indexer.refresh = () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      do {
        again = false;
        result = await build();
        if (result !== current) {
          current = result;
          indexer.emit('graph', current);
        }
      } while (again);
      running = null;
      return result;
    })();
    return running;
  };

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
export function createWorkerParser() {
  const worker = new Worker(new URL('./graph-worker.js', import.meta.url));
  worker.unref();
  const waiting = new Map();
  let serial = 0;
  worker.on('message', ({ id, extract }) => {
    const entry = waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(id);
    entry.resolve(extract);
  });
  return {
    parse(source, relPath) {
      const id = ++serial;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ functions: [{ id: `${relPath}#<topo>`, name: '<topo>', startLine: 1, endLine: String(source).split('\n').length }], imports: [], calls: [], error: 'timeout' });
        }, PARSE_TIMEOUT_MS);
        waiting.set(id, { resolve, timer });
        worker.postMessage({ id, source, relPath });
      });
    },
    close: () => worker.terminate(),
  };
}
