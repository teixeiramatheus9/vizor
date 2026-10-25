// Themes are whole skins: they change layout language, type and chrome.
// Palettes only swap the colour token set, and only the classic skin offers
// them — arcade carries its own fixed neon look.
export const THEMES = {
  classico: { label: 'clássico' },
  arcade: { label: 'arcade' },
};

export const PALETTES = {
  aco: { label: 'azul-aço' },
  ambar: { label: 'âmbar crt' },
  magenta: { label: 'magenta synth' },
  ciano: { label: 'ciano gelo' },
  mono: { label: 'monocromo escuro' },
  giz: { label: 'monocromo claro' },
  magma: { label: 'magma reator' },
  matrix: { label: 'matrix code' },
  pipboy: { label: 'pip-boy 3000' },
};

export const DEFAULT_THEME = 'classico';
export const DEFAULT_PALETTE = 'mono';

// Configs written before skins existed keep a palette name in `theme` — carry
// it over to the palette field and land on the classic skin. Unknown values
// (a removed palette, hand-edited json) normalize to the defaults instead of
// lingering and painting nothing.
export function migrateThemeConfig(config) {
  const migrated = { ...config };
  if (PALETTES[migrated.theme]) {
    migrated.palette = migrated.theme;
    migrated.theme = 'classico';
  } else if (!THEMES[migrated.theme]) {
    migrated.theme = DEFAULT_THEME;
  }
  if (!PALETTES[migrated.palette]) migrated.palette = DEFAULT_PALETTE;
  return migrated;
}

// The surface colour of a skin/palette, read from the shared tokens.css so a
// new window's first frame matches the page instead of flashing dark on the
// light palette (#108). Falls back to the dark default.
export function backgroundFor({ theme, palette }, css) {
  const surface = (selector) => {
    const escaped = selector.replace(/[[\]()]/g, '\\$&');
    return String(css ?? '').match(new RegExp(`${escaped}\\s*\\{[^}]*--bg-surface:\\s*(#[0-9a-fA-F]{3,8})`))?.[1] ?? null;
  };
  if (theme === 'arcade') return surface("body[data-theme='arcade']") ?? '#0d1117';
  return surface(`body[data-palette='${palette}']`) ?? surface(':root') ?? '#0d1117';
}
