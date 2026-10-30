import path from 'node:path';
import fsp from 'node:fs/promises';
import { sniffImageType } from './project-avatar.js';

// A project's own logo, found inside its working tree (no network). First hit
// wins: package.json `icon`, the electron-builder icon, then the usual file
// names. Only git-tracked files of at most LOGO_MAX_BYTES, resolved inside the
// project root (realpath included). Returns a data: URI or null.

export const LOGO_MAX_BYTES = 512 * 1024;

const COMMON = [
  'logo.svg', 'logo.png', 'icon.svg', 'icon.png',
  'assets/logo.svg', 'assets/logo.png', 'assets/icon.svg', 'assets/icon.png',
  'public/logo.svg', 'public/logo.png', 'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico',
  'static/favicon.png', 'static/favicon.ico',
  'src/assets/logo.svg', 'src/assets/logo.png',
  '.github/logo.svg', '.github/logo.png', 'docs/logo.svg', 'docs/logo.png',
  'build/icon.png',
];

const readJson = async (file) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// A repo-relative, forward-slash path that stays inside the root; else null.
export function cleanRelative(value) {
  const raw = str(value);
  if (!raw || raw.includes('\0') || path.isAbsolute(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const normal = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.startsWith('/')) return null;
  return normal;
}

async function declaredIcons(root) {
  const icons = [];
  const pkg = await readJson(path.join(root, 'package.json'));
  icons.push(pkg?.icon);
  icons.push(pkg?.build?.icon, pkg?.build?.linux?.icon, pkg?.build?.mac?.icon);
  const json = await readJson(path.join(root, 'electron-builder.json'));
  icons.push(json?.icon);
  try {
    const yml = await fsp.readFile(path.join(root, 'electron-builder.yml'), 'utf8');
    const match = yml.match(/^icon:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/m);
    icons.push(match?.[1]);
  } catch {
    // no yml
  }
  return icons;
}

// An SVG goes through an <img>, where scripts and loads never run; this is a
// second wall: anything that could script or reach out is refused outright
// (rejecting is sturdier than rewriting).
export function sanitizeSvg(text) {
  const svg = String(text ?? '');
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) return null;
  if (/<!doctype|<!entity|<script|<foreignobject|<iframe|<embed|<object|<audio|<video|<image|@import|javascript:|data:|&[a-z#][^;\s]*;/i.test(svg)) return null;
  if (/[\s"'/]on[a-z]+\s*=/i.test(svg)) return null;
  for (const match of svg.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) if (!match[2].trim().startsWith('#')) return null;
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) if (!match[2].trim().startsWith('#')) return null;
  return svg;
}

// The biggest PNG frame inside an ICO, or null (BMP frames are skipped).
export function pngFromIco(bytes) {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count && 6 + i * 16 + 16 <= bytes.length; i += 1) {
    const size = bytes.readUInt32LE(6 + i * 16 + 8);
    const offset = bytes.readUInt32LE(6 + i * 16 + 12);
    if (!size || offset + size > bytes.length) continue;
    const frame = bytes.subarray(offset, offset + size);
    if (sniffImageType(frame) !== 'image/png') continue;
    if (!best || frame.length > best.length) best = frame;
  }
  return best ? Buffer.from(best) : null;
}

function toUri(bytes, ext) {
  if (ext === '.svg') {
    const clean = sanitizeSvg(bytes.toString('utf8'));
    return clean ? `data:image/svg+xml;base64,${Buffer.from(clean).toString('base64')}` : null;
  }
  const image = ext === '.ico' ? pngFromIco(bytes) : bytes;
  const type = image && sniffImageType(image);
  return type ? `data:${type};base64,${image.toString('base64')}` : null;
}

// listTracked(paths) resolves the Set of those repo-relative paths git tracks.
export async function findLocalLogo({ root, listTracked }) {
  const candidates = [...new Set([...(await declaredIcons(root)).map(cleanRelative), ...COMMON].filter(Boolean))];
  if (!candidates.length) return null;
  let realRoot;
  let tracked;
  try {
    realRoot = await fsp.realpath(root);
    tracked = await listTracked(candidates);
  } catch {
    return null;
  }
  for (const rel of candidates) {
    const ext = path.extname(rel).toLowerCase();
    if (!tracked.has(rel) || !['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(ext)) continue;
    try {
      const real = await fsp.realpath(path.join(root, rel));
      if (!real.startsWith(realRoot + path.sep)) continue;
      const stat = await fsp.stat(real);
      if (!stat.isFile() || stat.size > LOGO_MAX_BYTES) continue;
      const uri = toUri(await fsp.readFile(real), ext);
      if (uri) return uri;
    } catch {
      // unreadable: try the next one
    }
  }
  return null;
}
