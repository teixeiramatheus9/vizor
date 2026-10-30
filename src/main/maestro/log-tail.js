import fs from 'node:fs';

// The end of a background command's log (#142): only the last bytes are
// read, so a dev server that logged for hours costs the same as a fresh one.
export async function readTail(filePath, { maxBytes = 16384, lines = 12 } = {}) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const { size, mtimeMs } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8').split('\n');
    if (start > 0) text = text.slice(1); // the first line came cut
    return { lines: text.filter((line) => line.trim() !== '').slice(-lines), gone: false, mtimeMs };
  } catch {
    return { lines: [], gone: true, mtimeMs: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}
