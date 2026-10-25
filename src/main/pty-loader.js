import { createRequire } from 'node:module';

// The terminal's native module, loaded only on Linux (the workspace is Linux
// only in v1) and only when the first terminal opens — a bubble-only user
// never loads native code. @lydell/node-pty is upstream node-pty repackaged
// with prebuilt N-API binaries: the official package compiles on Linux, which
// needs a C++ toolchain most desktops don't have.
let cached = null;

export function loadPty({ platform = process.platform } = {}) {
  if (platform !== 'linux') return { pty: null, error: 'só no Linux' };
  if (cached) return cached;
  try {
    cached = { pty: createRequire(import.meta.url)('@lydell/node-pty'), error: null };
  } catch (error) {
    cached = { pty: null, error: error?.message ?? String(error) };
  }
  return cached;
}
