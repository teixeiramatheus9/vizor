import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installVoice, voicePaths } from '../src/main/sherpa-installer.js';

describe('installVoice', () => {
  it('voices that share files never download them twice at once (review: clara, then en-0, mid-download)', async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-install-'));
    const fetched = [];
    const fetchFn = async (url) => {
      fetched.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    };
    // tar "extracts" what the voice needs, a moment later.
    const spawnFn = () => {
      const child = new EventEmitter();
      setTimeout(() => {
        const { binary, model } = voicePaths(dir, 'clara');
        for (const file of [binary, model]) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, '');
        }
        child.emit('close', 0);
      }, 5);
      return child;
    };
    const results = await Promise.all([installVoice(dir, 'clara', { fetchFn, spawnFn }), installVoice(dir, 'en-0', { fetchFn, spawnFn })]);
    expect(results).toEqual([true, true]);
    expect(fetched).toHaveLength(2); // one runtime, one model
  });
});
