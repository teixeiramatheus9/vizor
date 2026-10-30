import { createRequire } from 'node:module';

// The terminal's native module, loaded only on Linux (the workspace is Linux
// only in v1) and only when the first terminal opens — a bubble-only user
// never loads native code. @lydell/node-pty is upstream node-pty repackaged
// with prebuilt N-API binaries: the official package compiles on Linux, which
// needs a C++ toolchain most desktops don't have.
let cached = null;

const defaultRequire = (name) => createRequire(import.meta.url)(name);

export function loadPty({ platform = process.platform, requireModule = defaultRequire, fresh = false } = {}) {
  if (platform !== 'linux') return { pty: null, error: 'só no Linux' };
  if (cached && !fresh) return cached;
  try {
    cached = { pty: requireModule('@lydell/node-pty'), error: null };
  } catch (error) {
    // The window shows `error` (pt-BR); the upstream message goes to the log (#114).
    cached = { pty: null, error: 'o módulo de terminal não carregou', detail: error?.message ?? String(error) };
  }
  return cached;
}
