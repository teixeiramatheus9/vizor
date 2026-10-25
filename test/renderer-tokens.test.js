import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (name) => fs.readFileSync(path.join(rendererDir, name), 'utf8');

describe('theme tokens', () => {
  it('app.html takes its tokens from tokens.css', () => {
    expect(read('app.html')).toContain('<link rel="stylesheet" href="tokens.css" />');
    expect(read('app.html')).not.toMatch(/--bg-surface:\s*#/);
  });

  it('tokens.css carries every palette and the arcade skin', () => {
    const css = read('tokens.css');
    for (const palette of ['ambar', 'magenta', 'ciano', 'mono', 'giz', 'magma', 'matrix', 'pipboy'])
      expect(css).toContain(`body[data-palette='${palette}']`);
    expect(css).toContain("body[data-theme='arcade']");
  });
});
