import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findLocalLogo, sanitizeSvg, pngFromIco, LOGO_MAX_BYTES } from '../src/main/local-logo.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

function project(files, { tracked } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'logo-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const set = new Set(tracked ?? Object.keys(files));
  return { root, listTracked: async (paths) => new Set(paths.filter((p) => set.has(p))) };
}
const find = (p) => findLocalLogo({ root: p.root, listTracked: p.listTracked });

describe('findLocalLogo order', () => {
  it('prefers package.json icon over everything', async () => {
    const p = project({ 'package.json': JSON.stringify({ icon: 'img/x.png', build: { icon: 'assets/b.png' } }), 'img/x.png': PNG, 'assets/b.png': Buffer.concat([PNG, Buffer.from('b')]), 'logo.png': PNG });
    expect(await find(p)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });
  it('then electron-builder icons (build.icon, linux, mac)', async () => {
    const other = Buffer.concat([PNG, Buffer.from('L')]);
    const p = project({ 'package.json': JSON.stringify({ build: { linux: { icon: 'l.png' } } }), 'l.png': other, 'logo.png': PNG });
    expect(await find(p)).toContain(other.toString('base64'));
  });
  it('reads electron-builder.yml and .json', async () => {
    const yml = project({ 'electron-builder.yml': 'appId: x\nicon: "res/i.png"\n', 'res/i.png': PNG, 'logo.png': Buffer.from('x') });
    expect(await find(yml)).toContain(PNG.toString('base64'));
    const json = project({ 'electron-builder.json': JSON.stringify({ icon: 'res/i.png' }), 'res/i.png': PNG });
    expect(await find(json)).toContain(PNG.toString('base64'));
  });
  it('then common files in the documented order', async () => {
    const a = Buffer.concat([PNG, Buffer.from('a')]);
    const p = project({ 'assets/icon.png': PNG, 'public/favicon.png': a });
    expect(await find(p)).toContain(PNG.toString('base64'));
    const q = project({ 'public/favicon.png': a, 'logo.png': PNG });
    expect(await find(q)).toContain(PNG.toString('base64'));
  });
  it('logo.svg beats logo.png', async () => {
    const p = project({ 'logo.svg': SVG, 'logo.png': PNG });
    expect(await find(p)).toMatch(/^data:image\/svg\+xml;base64,/);
  });
  it('is null when nothing exists', async () => {
    expect(await find(project({ 'README.md': 'x' }))).toBeNull();
  });
});

describe('findLocalLogo safety', () => {
  it('only uses git-tracked files', async () => {
    const p = project({ 'assets/icon.png': PNG }, { tracked: [] });
    expect(await find(p)).toBeNull();
  });
  it('refuses files over the size cap', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(await find(project({ 'logo.png': big }))).toBeNull();
  });
  it('refuses paths that escape the project', async () => {
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.png`);
    fs.writeFileSync(outside, PNG);
    const p = project({ 'package.json': JSON.stringify({ icon: `../${path.basename(outside)}` }) });
    expect(await find(p)).toBeNull();
    const abs = project({ 'package.json': JSON.stringify({ icon: outside }) });
    expect(await find(abs)).toBeNull();
  });
  it('refuses a tracked symlink that points outside', async () => {
    const outside = path.join(os.tmpdir(), `outside2-${process.pid}.png`);
    fs.writeFileSync(outside, PNG);
    const p = project({ 'README.md': 'x' });
    fs.symlinkSync(outside, path.join(p.root, 'logo.png'));
    const q = { root: p.root, listTracked: async (paths) => new Set(paths) };
    expect(await find(q)).toBeNull();
  });
  it('refuses a file whose bytes are not an image', async () => {
    expect(await find(project({ 'logo.png': Buffer.from('<html>') }))).toBeNull();
  });
});

describe('sanitizeSvg', () => {
  it('keeps a plain svg', () => expect(sanitizeSvg(SVG)).toBe(SVG));
  it.each([
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="x()"></svg>',
    '<svg><rect onclick = "x()"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="https://e.x/a.png"/></svg>',
    '<svg><use xlink:href="http://e.x/a.svg#a"/></svg>',
    '<svg><style>@import url(http://e.x/a.css);</style></svg>',
    '<svg><rect fill="url(http://e.x/a)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg><a href="javascript:alert(1)"/></svg>',
    '<div>not svg</div>',
  ])('rejects %s', (svg) => expect(sanitizeSvg(svg)).toBeNull());
  it('allows fragment references', () => {
    const ok = '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>';
    expect(sanitizeSvg(ok)).toBe(ok);
  });
});

describe('pngFromIco', () => {
  const ico = (frames) => {
    const header = Buffer.alloc(6 + 16 * frames.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(frames.length, 4);
    let offset = header.length;
    frames.forEach((frame, i) => {
      header.writeUInt32LE(frame.length, 6 + i * 16 + 8);
      header.writeUInt32LE(offset, 6 + i * 16 + 12);
      offset += frame.length;
    });
    return Buffer.concat([header, ...frames]);
  };
  it('extracts the biggest png frame', () => {
    const small = PNG;
    const big = Buffer.concat([PNG, Buffer.from('bigger')]);
    expect(pngFromIco(ico([small, big]))).toEqual(big);
  });
  it('skips an ico with only bmp frames or garbage', () => {
    expect(pngFromIco(ico([Buffer.from('BMPDATA-not-png')]))).toBeNull();
    expect(pngFromIco(Buffer.from('nope'))).toBeNull();
  });
});
