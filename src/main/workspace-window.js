// The workspace is a normal desktop window — framed, resizable, never on top
// — unlike the bubble's overlays. Created on first open and hidden, not
// destroyed, on close: the terminals (#92) and edit history live in main, and
// reopening must be instant. Electron classes are injected to keep this file
// free of a hard electron import.
const SAVE_BOUNDS_DELAY_MS = 500;

export function createWorkspaceWindowManager({
  BrowserWindow,
  preloadPath,
  htmlPath,
  loadBounds,
  saveBounds,
  onShow,
  isQuitting,
}) {
  let win = null;
  let loaded = false;
  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) saveBounds(win.getBounds());
    }, SAVE_BOUNDS_DELAY_MS);
  }

  function create() {
    const bounds = loadBounds();
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      ...(bounds ?? {}),
      minWidth: 900,
      minHeight: 560,
      title: 'Vizor — workspace',
      backgroundColor: '#0d1117',
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: preloadPath, contextIsolation: true },
    });
    // Electron's default menu brings a Quit (Ctrl+Q, File > Quit) that calls
    // app.quit() straight — it would kill the live terminals without the
    // confirmation the tray and panel ask for.
    win.removeMenu();
    win.on('close', (event) => {
      if (isQuitting()) return;
      event.preventDefault();
      win.hide();
    });
    win.on('move', scheduleSave);
    win.on('resize', scheduleSave);
    // A fresh snapshot on every load and show: the palette or the sessions may
    // have changed while the window was hidden.
    win.webContents.on('did-finish-load', () => {
      loaded = true;
      onShow();
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(htmlPath);
  }

  return {
    show() {
      if (!win || win.isDestroyed()) {
        create();
        return;
      }
      win.show();
      win.focus();
      onShow();
    },
    send(channel, payload) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    isOpen() {
      return Boolean(win && !win.isDestroyed() && win.isVisible());
    },
    // Loaded is what matters for a send: the first snapshot goes out on
    // did-finish-load, which can come before ready-to-show maps the window.
    isReady() {
      return Boolean(win && !win.isDestroyed() && loaded);
    },
    destroy() {
      clearTimeout(saveTimer);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      loaded = false;
    },
  };
}
