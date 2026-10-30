// A project's colour in the sidebar: the dominant colour of its avatar, or —
// when there is no avatar — a colour derived from its name. Pure helpers.

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function rgbToHsl(r, g, b) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// Readable on both the dark and the light panels: lightness held to the
// middle band, saturation to a visible-but-calm one. Near-greys stay grey.
export function nudgeColor(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = s < 0.12 ? s : Math.min(0.7, Math.max(0.35, s));
  return hex(hslToRgb(h, sat, Math.min(0.62, Math.max(0.45, l))));
}

// RGBA bytes (canvas ImageData); only mostly-opaque pixels count. null when none.
export function averageColor(data) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }
  return count ? [Math.round(r / count), Math.round(g / count), Math.round(b / count)] : null;
}

// FNV-1a: the same name always lands on the same hue.
function hash(text) {
  let h = 0x811c9dc5;
  for (const char of text) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function monogramColor(name) {
  const hue = hash(String(name ?? '').toLowerCase()) % 360;
  return nudgeColor(...hslToRgb(hue, 0.55, 0.52));
}

export function monogramOf(name) {
  const first = [...String(name ?? '')].find((char) => /[\p{L}\p{N}]/u.test(char));
  return first ? first.toUpperCase() : '?';
}
