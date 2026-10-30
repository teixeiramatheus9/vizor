import { describe, it, expect } from 'vitest';
import {
  THEMES,
  PALETTES,
  DEFAULT_THEME,
  DEFAULT_PALETTE,
  migrateThemeConfig,
} from '../src/main/themes.js';
import { backgroundFor } from '../src/main/themes.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('themes', () => {
  it('ships the classic and arcade skins', () => {
    expect(THEMES.classico).toBeDefined();
    expect(THEMES.arcade).toBeDefined();
  });

  it('defaults to a theme and a palette that exist', () => {
    expect(THEMES[DEFAULT_THEME]).toBeDefined();
    expect(PALETTES[DEFAULT_PALETTE]).toBeDefined();
  });

  it('gives every theme and palette a label for the settings dropdowns', () => {
    for (const [value, spec] of Object.entries({ ...THEMES, ...PALETTES })) {
      expect(spec.label, `entry ${value}`).toBeTypeOf('string');
      expect(spec.label.length, `entry ${value}`).toBeGreaterThan(0);
    }
  });

  it('keeps the pip-boy phosphor palette', () => {
    expect(PALETTES.pipboy).toBeDefined();
  });
});

describe('migrateThemeConfig', () => {
  it('moves a pre-skin colour theme into the palette field of the classic skin', () => {
    const migrated = migrateThemeConfig({ theme: 'magenta', crt: true });
    expect(migrated.theme).toBe('classico');
    expect(migrated.palette).toBe('magenta');
    expect(migrated.crt).toBe(true);
  });

  it('passes a new-style config through untouched', () => {
    const config = { theme: 'arcade', palette: 'ciano' };
    expect(migrateThemeConfig(config)).toEqual(config);
  });

  it('falls back to defaults when the stored theme is unknown', () => {
    const migrated = migrateThemeConfig({ theme: 'vaporwave', palette: 'giz' });
    expect(migrated.theme).toBe(DEFAULT_THEME);
    expect(migrated.palette).toBe('giz');
  });

  it('normalizes an unknown palette instead of letting it linger', () => {
    const migrated = migrateThemeConfig({ theme: 'classico', palette: 'plasma' });
    expect(migrated.palette).toBe(DEFAULT_PALETTE);
  });
});

describe('backgroundFor (#108)', () => {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'tokens.css'), 'utf8');

  it('reads the palette surface colour from the shared tokens', () => {
    const giz = css.match(/body\[data-palette='giz'\]\s*\{[^}]*--bg-surface:\s*(#[0-9a-fA-F]{3,8})/)[1];
    expect(backgroundFor({ theme: 'classico', palette: 'giz' }, css)).toBe(giz);
  });

  it('the arcade skin wins over the palette, and unknown values fall back to the root', () => {
    const arcade = css.match(/body\[data-theme='arcade'\]\s*\{[^}]*--bg-surface:\s*(#[0-9a-fA-F]{3,8})/)[1];
    expect(backgroundFor({ theme: 'arcade', palette: 'giz' }, css)).toBe(arcade);
    const root = css.match(/:root\s*\{[^}]*--bg-surface:\s*(#[0-9a-fA-F]{3,8})/)[1];
    expect(backgroundFor({ theme: 'classico', palette: 'nope' }, css)).toBe(root);
    expect(backgroundFor({ theme: 'classico', palette: 'giz' }, '')).toBe('#0d1117');
  });
});
