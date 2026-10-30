import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  isValidAccelerator,
  sanitizeShortcuts,
} from '../src/main/shortcuts.js';

describe('SHORTCUT_ACTIONS', () => {
  it('covers the four main actions with pt-BR labels', () => {
    expect(SHORTCUT_ACTIONS.map((a) => a.id)).toEqual(['panel', 'bubble', 'find', 'chat', 'voiceTalk', 'voiceMute']);
    for (const action of SHORTCUT_ACTIONS) expect(action.label).toBeTruthy();
  });

  it('ships find-the-bubble bound to its historical default', () => {
    expect(DEFAULT_SHORTCUTS.find).toBe('CommandOrControl+Alt+B');
    expect(DEFAULT_SHORTCUTS.panel).toBe('');
  });
});

describe('isValidAccelerator', () => {
  it('accepts modifier+key combos in electron accelerator form', () => {
    expect(isValidAccelerator('Ctrl+Alt+B')).toBe(true);
    expect(isValidAccelerator('CommandOrControl+Alt+B')).toBe(true);
    expect(isValidAccelerator('Super+Shift+F5')).toBe(true);
    expect(isValidAccelerator('Alt+Space')).toBe(true);
    expect(isValidAccelerator('Ctrl+Plus')).toBe(true);
  });

  it('rejects a bare key — it would hijack normal typing', () => {
    expect(isValidAccelerator('B')).toBe(false);
    expect(isValidAccelerator('F5')).toBe(false);
  });

  it('rejects modifiers without a key and malformed strings', () => {
    expect(isValidAccelerator('Ctrl+Alt')).toBe(false);
    expect(isValidAccelerator('Ctrl+')).toBe(false);
    expect(isValidAccelerator('')).toBe(false);
    expect(isValidAccelerator(null)).toBe(false);
    expect(isValidAccelerator('Banana+B')).toBe(false);
  });
});

describe('sanitizeShortcuts', () => {
  it('applies valid changes over the current set', () => {
    const next = sanitizeShortcuts({ panel: 'Ctrl+Alt+P' }, DEFAULT_SHORTCUTS);
    expect(next.panel).toBe('Ctrl+Alt+P');
    expect(next.find).toBe('CommandOrControl+Alt+B');
  });

  it('clears a binding on empty string', () => {
    expect(sanitizeShortcuts({ find: '' }, DEFAULT_SHORTCUTS).find).toBe('');
  });

  it('drops invalid accelerators and unknown actions', () => {
    const next = sanitizeShortcuts({ panel: 'P', selfDestruct: 'Ctrl+Alt+X' }, DEFAULT_SHORTCUTS);
    expect(next.panel).toBe('');
    expect(next.selfDestruct).toBeUndefined();
  });

  it('blanks the older binding when two actions would share one combo', () => {
    const current = { ...DEFAULT_SHORTCUTS, panel: 'Ctrl+Alt+B' };
    const next = sanitizeShortcuts({ find: 'Ctrl+Alt+B' }, current);
    expect(next.find).toBe('Ctrl+Alt+B');
    expect(next.panel).toBe('');
  });
});
