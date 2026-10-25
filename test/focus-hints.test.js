import { describe, expect, it } from 'vitest';
import { linuxFocusHint, win32FocusHint, hintAnnouncement } from '../src/main/focus-hints.js';

describe('linuxFocusHint', () => {
  it('asks for xdotool when X listing failed', () => {
    expect(linuxFocusHint({ cause: 'no-x-windows' }, null)?.key).toBe('xdotool');
    expect(linuxFocusHint({ cause: 'xdotool-failed' }, null)?.key).toBe('xdotool');
  });

  it('points at allow_remote_control when kitty has no listener', () => {
    const hint = linuxFocusHint({ tabFound: false, cause: null }, { KITTY_WINDOW_ID: '3' });
    expect(hint?.key).toBe('kitty-remote');
    expect(hint.body).toContain('allow_remote_control');
  });

  // On a Wayland session the GNOME terminals run Wayland-native and never
  // show up to xdotool — the click silently did nothing. That deserves an
  // explanation, not silence (issue #67's acceptance criterion).
  it('explains the Wayland wall when the terminal is out of X reach', () => {
    const hint = linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
      canInjectInput: false,
    });
    expect(hint?.key).toBe('wayland-terminal');
    expect(hint.body.toLowerCase()).toContain('wayland');
    expect(hint.speech).toBeTruthy();
  });

  it('points at the bridge install button when there is no bridge', () => {
    const hint = linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
      canInjectInput: false,
      bridge: 'none',
    });
    expect(hint?.key).toBe('wayland-terminal');
    expect(hint.body).toContain('ponte');
  });

  it('asks for a relogin when the bridge is installed but asleep', () => {
    const hint = linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
      canInjectInput: false,
      bridge: 'asleep',
    });
    expect(hint?.key).toBe('bridge-asleep');
    expect(hint.speech).toBeTruthy();
  });

  it('stays quiet on wayland when the bridge is active (terminal is just closed)', () => {
    expect(
      linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
        canInjectInput: false,
        bridge: 'active',
      }),
    ).toBeNull();
  });

  it('stays quiet about terminal-not-in-x on a plain X11 session', () => {
    expect(
      linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
        canInjectInput: true,
      }),
    ).toBeNull();
  });

  it('every hint carries a spoken line for the manager voice', () => {
    for (const hint of [
      linuxFocusHint({ cause: 'no-x-windows' }, null),
      linuxFocusHint({ tabFound: false, cause: null }, { KITTY_WINDOW_ID: '3' }),
      linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null, {
        canInjectInput: false,
      }),
    ]) {
      expect(hint.speech).toBeTruthy();
    }
  });

  it('stays quiet when the tab was found or nothing is actionable', () => {
    expect(
      linuxFocusHint(
        { tabFound: true, cause: null },
        { KITTY_WINDOW_ID: '3' }, // found via title hunt — no nagging
      ),
    ).toBeNull();
    expect(
      linuxFocusHint(
        { tabFound: false, cause: null },
        { KITTY_WINDOW_ID: '3', KITTY_LISTEN_ON: 'unix:/tmp/k' }, // config is fine
      ),
    ).toBeNull();
    expect(linuxFocusHint({ tabFound: false, cause: 'terminal-not-in-x' }, null)).toBeNull();
  });
});

describe('win32FocusHint', () => {
  it('asks about powershell when the native layer failed', () => {
    const hint = win32FocusHint({ focused: false, tabFound: false, cause: 'powershell-failed' });
    expect(hint?.key).toBe('powershell');
    expect(hint.speech).toBeTruthy();
  });

  it('points at hidden tab titles only after a hunt saw every tab and matched none', () => {
    const hint = win32FocusHint({ focused: true, tabFound: false, cause: 'no-tab-matched' });
    expect(hint?.key).toBe('tab-titles');
    expect(hint.body).toContain('suppressApplicationTitle');
    expect(hint.speech).toBeTruthy();
  });

  it('explains a refused foreground instead of blaming the tab titles', () => {
    const hint = win32FocusHint({ focused: true, tabFound: false, cause: 'focus-refused' });
    expect(hint?.key).toBe('focus-refused');
    expect(hint.body).not.toContain('suppressApplicationTitle');
    expect(hint.speech).toBeTruthy();
  });

  it('stays quiet when no tab hunt ever ran', () => {
    // WaveTerm's block-gone return and the plain "raised some window" return
    // both look like this — telling those users to unhide tab titles is noise.
    expect(win32FocusHint({ focused: true, tabFound: false, cause: null })).toBeNull();
  });

  it('stays quiet when the tab was found or no terminal exists', () => {
    expect(win32FocusHint({ focused: true, tabFound: true, cause: null })).toBeNull();
    expect(win32FocusHint({ focused: false, tabFound: false, cause: 'terminal-not-found' })).toBeNull();
    expect(win32FocusHint({ focused: false, tabFound: false, cause: 'no-windows' })).toBeNull();
  });
});


// Issue #62: every manager warning must reach the bubble's balloon too, with
// the actionable body — and never be spoken twice (the balloon adds no speech).
describe('hintAnnouncement', () => {
  const hint = { key: 'xdotool', title: 'T', body: 'instala com sudo apt', speech: 'fala' };

  it('builds balloon, notification and speech from one hint', () => {
    expect(hintAnnouncement(hint)).toEqual({
      tooltip: { projectName: 'Vizor', text: 'instala com sudo apt', kind: 'hint' },
      notification: { title: 'T', body: 'instala com sudo apt' },
      speech: 'fala',
    });
  });

  it('is null for a null hint', () => {
    expect(hintAnnouncement(null)).toBeNull();
  });
});

describe('hintAnnouncement for an English voice', () => {
  it('speaks a short English line; the screen keeps the pt-BR how-to', () => {
    const hint = { key: 'k', title: 'T', body: 'Instala o xdotool.', speech: 'Preciso do xdotool!' };
    const parts = hintAnnouncement(hint, 'en');
    expect(parts.speech).toBe("I need a quick setup tweak from you. The details are on screen.");
    expect(parts.tooltip.text).toBe('Instala o xdotool.');
    expect(hintAnnouncement(hint).speech).toBe('Preciso do xdotool!');
  });
});
