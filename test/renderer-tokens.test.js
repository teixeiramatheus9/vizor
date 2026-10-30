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

  it('the compact density shrinks the fonts under the arcade skin too', () => {
    const css = read('tokens.css');
    const block = (selector) => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? null : { at, body: css.slice(at, css.indexOf('}', at)) };
    };
    const size = (body, token) => Number(body.match(new RegExp(`${token}:\\s*([\\d.]+)px`))?.[1]);
    const arcade = block("body[data-theme='arcade']");
    const compact = block("body[data-theme='arcade'][data-density='compact']");
    expect(compact).not.toBeNull();
    for (const token of ['--fs-xs', '--fs-sm', '--fs-base', '--fs-lg']) expect(size(compact.body, token)).toBeLessThan(size(arcade.body, token));
    expect(size(block("body[data-density='compact']").body, '--fs-base')).toBe(12.5);
  });
});
