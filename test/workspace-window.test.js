import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { boundsVisible, createWorkspaceWindowManager } from '../src/main/workspace-window.js';

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.sent = [];
    this.webContents.send = (channel, payload) => this.webContents.sent.push([channel, payload]);
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
