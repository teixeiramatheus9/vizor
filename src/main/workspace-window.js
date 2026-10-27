// The workspace is a normal desktop window — framed, resizable, never on top
// — unlike the bubble's overlays. Created on first open and hidden, not
// destroyed, on close: the terminals (#92) and edit history live in main, and
// reopening must be instant. Electron classes are injected to keep this file
// free of a hard electron import.
const SAVE_BOUNDS_DELAY_MS = 500;

// Saved bounds from a monitor that is gone would open the window off screen
// (#109): only reuse them when they overlap some display's work area.
export function boundsVisible(bounds, displays) {
  if (!bounds) return false;
  return displays.some(({ workArea: area }) =>
    bounds.x < area.x + area.width &&
    bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height &&
    bounds.y + bounds.height > area.y,
  );
}

export function createWorkspaceWindowManager({
  BrowserWindow,
  preloadPath,
  htmlPath,
  bootQuery,
  loadBounds,
  saveBounds,
  onShow,
  onFocus = () => {},
  onLoad = () => {},
  onGone = () => {},
  isQuitting,
  background = () => '#0d1117',
}) {
  let win = null;
  let loaded = false;
  let crashed = false;
  let pendingFocus = null; // a session to select once the page is up
  let saveTimer = null;
  const visibilityListeners = [];
  const tellVisibility = (visible) => { for (const listener of visibilityListeners) listener(visible); };

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
      backgroundColor: background(),
      show: false,
      autoHideMenuBar: true,
      // Terminals keep running behind a closed (hidden) window; throttled
      // timers there would stall xterm's parsing, and with flow control the
      // programs in the tabs with it (review of #113).
      webPreferences: { preload: preloadPath, contextIsolation: true, backgroundThrottling: false },
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
    win.on('hide', () => tellVisibility(false));
    win.on('minimize', () => tellVisibility(false));
    win.on('show', () => tellVisibility(true));
    win.on('restore', () => tellVisibility(true));
    win.on('focus', () => onFocus());
    win.on('move', scheduleSave);
    win.on('resize', scheduleSave);
    // A fresh snapshot on every load and show: the palette or the sessions may
    // have changed while the window was hidden.
    win.webContents.on('did-finish-load', () => {
      loaded = true;
      crashed = false;
      onLoad();
      onShow();
      if (pendingFocus) {
        win.webContents.send('workspace:focus', { sessionId: pendingFocus });
        pendingFocus = null;
      }
    });
    win.once('ready-to-show', () => win.show());
    // A dead page acks nothing: tell main (so terminals don't stay paused)
    // and reload on the next show.
    win.webContents.on('render-process-gone', () => {
      loaded = false;
      crashed = true;
      onGone();
    });
    win.loadFile(htmlPath, { query: bootQuery?.() ?? {} });
  }

  function show() {
    if (!win || win.isDestroyed()) {
      create();
      return;
    }
    if (crashed) win.webContents.reload();
    win.show();
    win.focus();
    onShow();
  }

  return {
    show,
    // Opens the workspace on a session (the bubble, a panel card). Asked
    // before the first load, it waits for the page instead of getting lost.
    focusSession(sessionId) {
      show();
      if (loaded && win && !win.isDestroyed()) win.webContents.send('workspace:focus', { sessionId });
      else pendingFocus = sessionId;
    },
    // cb(visible): false on hide/minimize, true on show/restore.
    onVisibility(callback) {
      visibilityListeners.push(callback);
    },
    isFocused() {
      return Boolean(win && !win.isDestroyed() && win.isFocused());
    },
    window() {
      return win && !win.isDestroyed() ? win : null;
    },
    // IPC that reaches the terminals must come from this window (#115).
    ownsSender(sender) {
      return Boolean(win && !win.isDestroyed() && sender === win.webContents);
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
