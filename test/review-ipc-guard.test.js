import { describe, it, expect } from 'vitest';
import { safeRelPath, sanitizePrefs } from '../src/main/review/ipc-guard.js';

describe('safeRelPath', () => {
  it('accepts plain relative paths', () => {
    expect(safeRelPath('src/a.js')).toBe('src/a.js');
    expect(safeRelPath('a..b/c.js')).toBe('a..b/c.js');
  });
  it('rejects absolute, parent, NUL and non-strings', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\..\\x', 'a\0b', '', 5, null, 'C:\\x'])
      expect(safeRelPath(bad)).toBeNull();
  });
});

describe('sanitizePrefs', () => {
  it('keeps only known keys with sane types', () => {
    expect(sanitizePrefs({ tab: 'impacto', drawerHeight: 300, drawerOpen: true, openFiles: ['a.js', '../x'], evil: 1 }))
      .toEqual({ tab: 'impacto', drawerHeight: 300, drawerOpen: true, openFiles: ['a.js'] });
    expect(sanitizePrefs({ tab: 5, drawerHeight: 'x', drawerOpen: 'y', openFiles: 'z' })).toEqual({});
    expect(sanitizePrefs(null)).toEqual({});
  });
});
