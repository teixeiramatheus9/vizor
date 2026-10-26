import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTail } from '../src/main/maestro/log-tail.js';

describe('readTail', () => {
  it('the last lines of a big file, reading only its end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-tail-'));
    const file = path.join(dir, 'task.output');
    fs.writeFileSync(file, Array.from({ length: 50000 }, (_, index) => `line ${index}`).join('\n') + '\n');
    const tail = await readTail(file, { maxBytes: 4096, lines: 3 });
    expect(tail.lines).toEqual(['line 49997', 'line 49998', 'line 49999']);
    expect(tail.gone).toBe(false);
    expect(tail.mtimeMs).toBeGreaterThan(0);
    // A cut first line is dropped, never shown half.
    const all = await readTail(file, { maxBytes: 40, lines: 50 });
    expect(all.lines.every((line) => /^line \d+$/.test(line))).toBe(true);
  });

  it('a missing file is gone, not an error', async () => {
    expect(await readTail('/nope/never/there.output')).toEqual({ lines: [], gone: true, mtimeMs: 0 });
  });
});
