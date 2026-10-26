import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { boundsVisible, createWorkspaceWindowManager } from '../src/main/workspace-window.js';

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new EventEmitter();
    this.webContents.sent = [];
    this.webContents.send = (channel, payload) => this.webContents.sent.push([channel, payload]);
    this.webContents.reload = () => { this.reloaded += 1; };
    this.visible = false;
    FakeWindow.last = this;
  }
  loadFile() {}
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  removeMenu() { this.menuRemoved = true; }
  reloaded = 0;
  isFocused() { return Boolean(this.focused); }
  getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; }
}

function manager(onShow = () => {}) {
  return createWorkspaceWindowManager({
    BrowserWindow: FakeWindow,
    preloadPath: 'p',
    htmlPath: 'h',
    loadBounds: () => null,
    saveBounds: () => {},
    onShow,
    isQuitting: () => false,
  });
}

describe('workspace window manager', () => {
  it('is ready to receive state as soon as the page loads, before it is shown', () => {
    const workspace = manager();
    workspace.show();
    expect(workspace.isReady()).toBe(false);
    FakeWindow.last.webContents.emit('did-finish-load');
    expect(FakeWindow.last.visible).toBe(false);
    expect(workspace.isReady()).toBe(true);
  });

  it('hides instead of closing while the app keeps running', () => {
    const workspace = manager();
    workspace.show();
    FakeWindow.last.webContents.emit('did-finish-load');
    FakeWindow.last.visible = true;
    let prevented = false;
    FakeWindow.last.emit('close', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(workspace.isOpen()).toBe(false);
    expect(workspace.isReady()).toBe(true);
  });

  it('has no application menu, so no Ctrl+Q that would skip the quit prompt', () => {
    manager().show();
    expect(FakeWindow.last.menuRemoved).toBe(true);
  });
});

describe('boundsVisible (#109)', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  it('keeps bounds that overlap a display and drops the ones off every screen', () => {
    expect(boundsVisible({ x: 100, y: 100, width: 800, height: 600 }, displays)).toBe(true);
    expect(boundsVisible({ x: 2500, y: 100, width: 800, height: 600 }, displays)).toBe(false);
    expect(boundsVisible(null, displays)).toBe(false);
  });
});

describe('pointing the workspace at a session (#96)', () => {
  it('waits for the page before asking it to focus a session, and sends only the latest', () => {
    const workspace = manager();
    workspace.focusSession('s1');
    workspace.focusSession('s2');
    const sent = FakeWindow.last.webContents.sent;
    expect(sent.filter(([channel]) => channel === 'workspace:focus')).toEqual([]);
    FakeWindow.last.webContents.emit('did-finish-load');
    expect(sent.filter(([channel]) => channel === 'workspace:focus')).toEqual([['workspace:focus', { sessionId: 's2' }]]);
    FakeWindow.last.webContents.emit('did-finish-load');
    expect(sent.filter(([channel]) => channel === 'workspace:focus')).toHaveLength(1);
  });

  it('sends right away to a loaded window, and shows it', () => {
    const workspace = manager();
    workspace.show();
    FakeWindow.last.webContents.emit('did-finish-load');
    workspace.focusSession('s3');
    expect(FakeWindow.last.webContents.sent.at(-1)).toEqual(['workspace:focus', { sessionId: 's3' }]);
    expect(FakeWindow.last.visible).toBe(true);
  });

  it('knows whether it has the focus', () => {
    const workspace = manager();
    expect(workspace.isFocused()).toBe(false);
    workspace.show();
    FakeWindow.last.focused = true;
    expect(workspace.isFocused()).toBe(true);
  });
});

describe('backlog review fixes', () => {
  it('keeps running timers while hidden: terminals must not throttle behind a closed window', () => {
    manager().show();
    expect(FakeWindow.last.options.webPreferences.backgroundThrottling).toBe(false);
  });

  it('a crashed page is not ready, reports it, and reloads on the next show', () => {
    const events = [];
    const workspace = createWorkspaceWindowManager({
      BrowserWindow: FakeWindow, preloadPath: 'p', htmlPath: 'h', loadBounds: () => null, saveBounds: () => {},
      onShow: () => events.push('show'), onLoad: () => events.push('load'), onGone: () => events.push('gone'),
      isQuitting: () => false,
    });
    workspace.show();
    FakeWindow.last.webContents.emit('did-finish-load');
    FakeWindow.last.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(workspace.isReady()).toBe(false);
    workspace.show();
    expect(FakeWindow.last.reloaded).toBe(1);
    expect(events).toEqual(['load', 'show', 'gone', 'show']);
  });

  it('tells onVisibility when the window hides, minimizes, shows and restores', () => {
    const workspace = manager();
    const seen = [];
    workspace.onVisibility((visible) => seen.push(visible));
    workspace.show();
    const win = FakeWindow.last;
    win.emit('hide');
    win.emit('show');
    win.emit('minimize');
    win.emit('restore');
    expect(seen).toEqual([false, true, false, true]);
  });
});
