import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHookCommand, ensureHooks, removeAppHooks } from '../../scripts/install-hooks.js';
import { SessionRegistry, displayName, haloState } from './session-registry.js';
import { startSocketServer, stopSocketServer } from './socket-server.js';
import { readAiTitle, readConversationTail, readTranscriptSnapshot } from './transcript.js';
import { generateManagerMessage, humanizeNotification, isPermissionAsk } from './manager-voice.js';
import { digestMessage } from './message-digest.js';
import { askManager, findMentionedSession } from './manager-chat.js';
import { fallbackMessage } from './manager-voice.js';
import { loadConfig, saveConfig } from './config-store.js';
import { TokenBudget } from './token-budget.js';
import { terminal, tts } from './platform.js';
import { VOICES } from './sherpa-installer.js';
import { THEMES, PALETTES } from './themes.js';
import { PANEL_SCALE, clampScale, panelSizeForScale } from './panel-size.js';
import {
  anchorVisible,
  centerAnchor,
  findBubbleAnchor,
  spotlightBounds,
} from './bubble-position.js';
import { sanitizeShortcuts } from './shortcuts.js';
import { applyLinuxAutostart, autostartFilePath, desktopEntry, execLine } from './autostart.js';
import { legacyAutostartFile, legacyConfigDir, migrateLegacyInstall } from './migration.js';
import { setupUpdater } from './updater.js';
import { detectTrayHost, trayMenuTemplate } from './tray.js';
import { installTraySupport, shouldInstallTraySupport } from './tray-support.js';
import { killPendingClaude } from './claude-cli.js';
import {
  socketPath,
  stateFile,
  sessionsFile,
  configFile,
  usageFile,
  updateNoticeFile,
  configDir,
} from './paths.js';
import {
  UPDATE_DONE_PHRASE,
  shouldAnnounce,
  shouldAutoApply,
  updateAnnouncement,
} from './update-notice.js';
import { log } from './log.js';
import { resolveDisplayMode, shouldRelaunchUnderX11 } from './display-mode.js';
import {
  readSessionChannel,
  readSessionPid,
  readLiveSessionIds,
  readAdoptableSessions,
  claudeTranscriptPath,
} from './cc-sessions.js';
import { readInboundPolicy, setInboundPolicy } from './claude-settings.js';
import {
  probeSystemEventsAutomation,
  accessibilityLostAfterUpdate,
  resetAccessibilityEntries,
  readGrantMemory,
  writeGrantMemory,
  ACCESSIBILITY_PANE,
  AUTOMATION_PANE,
} from './permissions-darwin.js';
import { linuxFocusHint, win32FocusHint, hintAnnouncement } from './focus-hints.js';
import { resolveWindowDriver } from './window-driver.js';
import { shouldAnnounce as notifyPolicy } from './notify-policy.js';
import { installBridge, uninstallBridge, bridgeStatus, autoSetupBridge } from './bridge-manager.js';
import { sendUserMessage } from './cc-peer.js';

// Two window-management modes:
// - X11/XWayland ("managed"): the app moves/positions its own window —
//   hold-anywhere drag with click detection, edge-aware flipping, persisted
//   position. mutter honours _NET_WM_STATE_ABOVE and _NET_WM_STATE_STICKY for
//   XWayland clients, which is the only way to get a real overlay on GNOME.
// - Wayland: the compositor owns positioning, so the bubble is a
//   -webkit-app-region drag handle and the window only grows/shrinks in place.
// The app asks for XWayland via --ozone-platform=x11 (see package.json). The
// switch has to come from the command line: appendSwitch() from this file runs
// too late, because Chromium picks the platform before main.js executes.
// macOS has neither DISPLAY nor a session type to read: Quartz always lets the
// app place its own windows, and input goes through System Events.
const displayMode =
  process.platform === 'darwin'
    ? { platform: 'darwin', managed: true, canInjectInput: true }
    : process.platform === 'win32'
      ? // Windows always lets apps place their own windows; input goes through
        // SendKeys (see win32-native.js).
        { platform: 'win32', managed: true, canInjectInput: true }
      : resolveDisplayMode({
          display: process.env.DISPLAY,
          ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
          sessionType: process.env.XDG_SESSION_TYPE,
        });
const canPositionWindows = displayMode.managed;

// Which window backend the hunt gets: xdotool on X11, the Vizor Bridge on
// Wayland when it answers. Cached briefly so a click never pays two probes.
let cachedDriver = null;
let cachedDriverAt = 0;

// The bridge is part of the app, so the first boot on a Wayland session sets
// it up by itself and the manager announces what happened. Removing it in the
// settings is an opt-out: auto-setup runs once per user, never again.
function autoSetupBridgeOnWayland() {
  if (process.platform !== 'linux' || displayMode.canInjectInput) return;
  autoSetupBridge({
    done: managerConfig.bridgeAutoSetupDone,
    markDone: () => {
      managerConfig = { ...managerConfig, bridgeAutoSetupDone: true };
      saveConfig(configFile, managerConfig);
    },
  })
    .then((result) => {
      cachedDriver = null; // pick the bridge up on the next focus click
      if (!result.ran) return;
      speakAsManager(
        result.active
          ? 'Instalei a ponte do GNOME! Agora eu te levo direto pra aba do teu chat.'
          : 'Instalei a ponte do GNOME! Sai e entra da sessão que aí eu alcanço teu terminal.',
      );
      sendToRenderer('tooltip', {
        projectName: 'Vizor',
        text: result.active
          ? 'Ponte do GNOME instalada e ativa — foco de aba liberado.'
          : 'Ponte do GNOME instalada — sai e entra da sessão pra ativar.',
        kind: 'done',
      });
      showTooltip();
    })
    .catch((error) => log(`bridge auto-setup failed: ${error}`));
}

// Bark or stay silent (issue #66): the card always updates, but chime, voice
// and balloon only fire when the user is NOT already looking at that chat.
const lastAnnouncements = new Map(); // sessionId → { text, at }

// Nickname resolution (issue #63): what the manager shows and speaks. The tab
// hunt keeps using cwd/projectName — the alias is display/speech only.
const displayNameOf = (session) => displayName(session);

const listWithDisplayNames = () =>
  registry.list().map((session) => ({ ...session, displayName: displayNameOf(session) }));

async function sessionFocused(session) {
  if (process.platform !== 'linux') return null; // V1: no probe elsewhere
  try {
    const { driver } = await windowDriver();
    const active = await driver.activeWindow?.();
    if (!active) return null;
    if (!terminal.isTerminalWindow(active)) return false;
    return terminal.titleMatchesKeys(active.title, await sessionSearchKeys(session));
  } catch {
    return null;
  }
}

async function allowAnnouncement(session, kind, text) {
  const decision = notifyPolicy({
    kind,
    text,
    focused: await sessionFocused(session),
    lastAnnouncement: lastAnnouncements.get(session.id) ?? null,
    announceWhenUnknown: managerConfig.announceWhenFocusUnknown,
    now: Date.now(),
  });
  if (decision.announce) {
    lastAnnouncements.set(session.id, { text, at: Date.now() });
  } else {
    log(`announcement suppressed (${decision.reason}) for ${session.id?.slice(0, 8)}`);
  }
  return decision.announce;
}

// 'none' | 'asleep' | 'active' — the hint pipeline says different things for
// "install the bridge", "relogin to wake it" and "it works, terminal is gone".
async function bridgeStateForHints() {
  if (displayMode.canInjectInput) return 'none'; // X11: hints never look at it
  const status = await bridgeStatus();
  if (!status.installed) return 'none';
  return status.responding ? 'active' : 'asleep';
}
async function windowDriver() {
  if (!cachedDriver || Date.now() - cachedDriverAt > 30_000) {
    cachedDriver = await resolveWindowDriver({ canInjectInput: displayMode.canInjectInput });
    cachedDriverAt = Date.now();
  }
  return cachedDriver;
}

// The AppImage launcher drops build.linux.executableArgs, so a packaged run can
// arrive here without the switch and silently lose the overlay. Relaunch once
// with it; the env marker is inherited by the new process and stops any loop.
const OZONE_RELAUNCH_MARKER = 'VIZOR_OZONE_RELAUNCHED';

function relaunchUnderX11IfNeeded() {
  const needed = shouldRelaunchUnderX11({
    display: process.env.DISPLAY,
    platform: displayMode.platform,
    // argv, not the command-line store: Chromium fills ozone-platform in with
    // the platform it picked, so the store cannot tell chosen from defaulted.
    switchPassed: process.argv.some((arg) => arg.startsWith('--ozone-platform')),
    alreadyRelaunched: Boolean(process.env[OZONE_RELAUNCH_MARKER]),
  });
  if (!needed) return false;
  log('relaunching with --ozone-platform=x11 (the launcher did not pass it)');
  process.env[OZONE_RELAUNCH_MARKER] = '1';
  app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
  return true;
}

// Associates the running window with the installed .desktop entry so desktop
// environments show the right icon/name for packaged builds.
app.setDesktopName?.('vizor.desktop');

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(currentDir, '..', 'renderer');
const preloadPath = path.join(rendererDir, 'preload.cjs');
const execFileAsync = promisify(execFile);
const iconPath = path.join(currentDir, '..', '..', 'assets', 'icon.png');
// A panel shows the icon small over its own background: the app tile would be
// a dark smudge next to the other status icons, so the tray gets the glyph.
const trayIconPath = path.join(currentDir, '..', '..', 'assets', 'tray-icon.png');

const MODE_SIZES = {
  bubble: { width: 56, height: 56 },
  tooltip: { width: 404, height: 100 },
  panel: { width: 436, height: 552 },
};
const BUBBLE_BOX = MODE_SIZES.bubble.width;
// The panel size is a setting, not a drag: growing it zooms the contents by
// the same factor, so the text gets bigger instead of more rows fitting.
function panelScale() {
  return clampScale(managerConfig.panelScale) / 100;
}

function panelSize() {
  const workArea = screen.getDisplayNearestPoint(bubbleAnchor ?? { x: 0, y: 0 }).workArea;
  return panelSizeForScale(managerConfig.panelScale, MODE_SIZES.panel, workArea);
}
const TOOLTIP_HIDE_MS = 8000;
const CLICK_THRESHOLD_PX = 6;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
// Short, because a closed terminal should leave the list right away rather
// than sit there claiming the chat is still working.
const LIVENESS_INTERVAL_MS = 15 * 1000;

// Rebrand adoption runs before the first config read: the claude-manager dir
// carries the user's position, sessions, settings and downloaded voices.
migrateLegacyInstall({
  legacyDir: legacyConfigDir(),
  targetDir: configDir,
  legacyAutostart: legacyAutostartFile(),
  enableAutostart: () => setAutostart(true),
  log,
});

const registry = new SessionRegistry({
  folderAliasFor: (cwd) => managerConfig.folderAliases[cwd] ?? null,
});
let managerConfig = loadConfig(configFile);
const tokenBudget = new TokenBudget({ file: usageFile });
const isEconomyMode = () => tokenBudget.isExceeded(managerConfig.tokenBudgetDaily);
let mainWindow = null;
let overlayWindow = null;
let settingsWindow = null;
let spotlightWindow = null;
let tray = null;
let socketServer = null;
let trayNeedsRelogin = false;
// Top-left corner of the bubble on screen — where the overlay is anchored.
let bubbleAnchor = null;
let dragState = null;

function sendToRenderer(channel, payload) {
  for (const win of [mainWindow, overlayWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// The OS owns the autostart truth (a file on Linux, login items elsewhere), so
// nothing is persisted in config.json — the checkbox reflects what really is.
function autostartEnabled() {
  if (process.platform === 'linux') return fs.existsSync(autostartFilePath());
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(enabled) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  const entry = desktopEntry({
    execLine: execLine({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appImage: process.env.APPIMAGE,
      appDir: path.join(currentDir, '..', '..'),
    }),
    iconPath,
  });
  applyLinuxAutostart(enabled, { entry });
}

let updateStatus = { mode: 'off', available: null, ready: null, installing: false };
let updaterHandle = { apply: () => {} };
let announcedUpdateVersion = null;

function sendState() {
  sendToRenderer('state', {
    sessions: listWithDisplayNames(),
    unread: registry.unreadCount(),
    update: updateStatus,
    hint: lastHint,
    voiceDownloading: tts.downloadingVoice(),
    theme: managerConfig.theme,
    palette: managerConfig.palette,
    trayAvailable: Boolean(tray),
    trayNeedsRelogin,
    crt: managerConfig.crt,
    shortcuts: { values: managerConfig.shortcuts, failed: shortcutFailures },
    autostart: autostartEnabled(),
    autoUpdate: managerConfig.autoUpdate,
    announceWhenFocusUnknown: managerConfig.announceWhenFocusUnknown,
    sound: {
      muted: managerConfig.muted,
      volume: managerConfig.soundVolume,
      voiceVolume: managerConfig.voiceVolume,
      timbre: managerConfig.timbre,
      ttsEnabled: managerConfig.ttsEnabled,
      typeVolumes: managerConfig.typeVolumes,
    },
    tokens: {
      usedToday: tokenBudget.usedToday(),
      budget: managerConfig.tokenBudgetDaily,
      economy: isEconomyMode(),
    },
  });
}

function speakAsManager(text) {
  if (!managerConfig.ttsEnabled) return;
  const volume = Math.round((managerConfig.voiceVolume * managerConfig.soundVolume) / 100);
  tts.speak(text, { voice: managerConfig.voice, volume });
}

// The install relaunches the app; the note left behind is what lets the new
// version announce itself (see announceUpdateIfJustInstalled).
function applyUpdate() {
  const version = updateStatus.ready ?? updateStatus.available;
  try {
    if (version) fs.writeFileSync(updateNoticeFile, JSON.stringify({ version }));
  } catch (error) {
    log(`update notice failed: ${error}`);
  }
  updaterHandle.apply();
}

// One auto-apply per version: a cancelled password prompt flips failed, and
// the same version must not come asking again on the next status change.
let autoApplyAttempted = null;

function onUpdateStatus(status) {
  const previous = updateStatus;
  updateStatus = status;
  sendState();
  if (status.installing !== previous.installing) {
    setFloatAboveEverything(!status.installing);
    if (status.installing) hideOverlay();
  }
  const phrase = updateAnnouncement(previous, status, managerConfig.autoUpdate);
  if (phrase) speakAsManager(phrase);
  const version = status.ready ?? status.available;
  if (version && announcedUpdateVersion !== version) {
    announcedUpdateVersion = version;
    sendToRenderer('tooltip', {
      projectName: 'Vizor',
      text: managerConfig.autoUpdate
        ? `Versão v${version} — vou me atualizar sozinho.`
        : status.ready
          ? `Atualização v${version} pronta! Clica no banner do painel pra reiniciar.`
          : `Versão v${version} disponível!`,
      kind: 'done',
    });
  }
  if (
    shouldAutoApply({
      autoUpdate: managerConfig.autoUpdate,
      mode: status.mode,
      available: status.available,
      ready: status.ready,
      installing: status.installing,
      failed: status.failed,
      attemptedVersion: autoApplyAttempted,
    })
  ) {
    autoApplyAttempted = status.mode === 'auto' ? status.ready : status.available;
    log(`updater: self-applying ${autoApplyAttempted}`);
    applyUpdate();
  }
}

function loadPersistedState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function persistAnchor() {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ bubble: bubbleAnchor }));
  } catch (error) {
    log(`persistAnchor failed: ${error}`);
  }
}

// The bubble lives in its own window that is never resized or moved on its
// own: resizing a transparent window on macOS repaints the old frame into the
// new geometry, which shows up as a ghost of the bubble. The panel and the
// toast live in a second window that is always positioned while hidden.
const OVERLAY_GAP = 8;

const clampTo = (value, min, max) => Math.min(Math.max(value, min), max);

function overlayBounds(mode) {
  const size = mode === 'panel' ? panelSize() : MODE_SIZES[mode];
  const anchor = bubbleAnchor ?? { x: 0, y: 0 };
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  let x = anchor.x + BUBBLE_BOX + OVERLAY_GAP;
  if (x + size.width > workArea.x + workArea.width) x = anchor.x - OVERLAY_GAP - size.width;
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width));
  let y = anchor.y;
  if (y + size.height > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - size.height;
  }
  y = Math.max(workArea.y, y);
  return { x, y, width: size.width, height: size.height };
}

let overlayMode = null;
let tooltipTimer = null;
// Clicking the bubble blurs the panel, which already closes it — without
// this the click that follows would just open it right back up.
let closedByBlurAt = 0;
let openedAt = 0;
const JUST_CLOSED_MS = 150;
// Clicking the bubble hands focus back to its window right after the panel
// opens; without this settle window the panel would blur itself shut.
const SETTLE_MS = 500;

// Re-applying zoom or bounds that did not change still makes Chromium drop
// and reallocate the window's frame, and show() then flashes an unpainted
// frame before the content lands — so both only run on a real change.
function applyZoom(win, factor) {
  if (win.webContents.getZoomFactor() !== factor) win.webContents.setZoomFactor(factor);
}

function applyBounds(win, bounds) {
  const current = win.getBounds();
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  ) {
    win.setBounds(bounds);
  }
}

// Windows plays a ~200ms cloak fade every time a hidden window is shown
// again, and on a transparent window nothing cancels it — frame captures
// show the desktop bleeding through the panel while it runs, which reads as
// a blink. So wherever windows can be positioned, "closed" overlay windows
// are never hidden: they park far offscreen, transparent and click-through,
// and opening is an atomic move back. Born parked, the one real show() (and
// its fade) plays offscreen at boot. Wayland keeps plain hide/show — no
// positioning there, and no such fade either.
const PARK = { x: -32000, y: -32000 };

// Where parking beats hiding is a property of the window manager, not of
// the OS name:
// - win32: park — DWM plays a ~200ms cloak fade on every show of a hidden
//   window (the blink parking exists to kill);
// - darwin: park — setOpacity is real and Quartz never clamps an offscreen
//   window back into view;
// - Wayland session (the app runs under XWayland): park — mutter re-places
//   a REMAPPED X window at the screen corner (position set while hidden is
//   ignored at map), so the window must never unmap; and mutter-on-Wayland
//   does not clamp offscreen X windows, so parked really means gone;
// - real X11 session: hide — the exact opposite: mutter-on-X11 bounces the
//   -32000 move back into the screen AND setOpacity is a no-op on Linux, so
//   a "parked" window sits visible and unclosable in the corner, while a
//   remapped window keeps its position fine.
const PARKING_PLATFORM =
  process.platform === 'win32' ||
  process.platform === 'darwin' ||
  (process.platform === 'linux' && !displayMode.canInjectInput);

function parkWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (!PARKING_PLATFORM || !canPositionWindows) return win.hide();
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  const { width, height } = win.getBounds();
  win.setBounds({ x: PARK.x, y: PARK.y, width, height });
  win.blur();
}

function unparkWindow(win, { focus = false } = {}) {
  if (!PARKING_PLATFORM || !canPositionWindows) {
    if (focus) win.show();
    else win.showInactive();
    return;
  }
  win.setIgnoreMouseEvents(false);
  win.setOpacity(1);
  if (!win.isVisible()) {
    // Only when born-parked could not run (window died and came back).
    if (focus) win.show();
    else win.showInactive();
  } else if (focus) {
    win.focus();
  }
}

function bornParked(win) {
  if (!PARKING_PLATFORM || !canPositionWindows) return;
  parkWindow(win);
  win.showInactive();
}

function showOverlay(mode, { focus = false } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayMode = mode;
  applyZoom(overlayWindow, mode === 'panel' ? panelScale() : 1);
  applyBounds(overlayWindow, overlayBounds(mode));
  overlayWindow.webContents.send('overlay:mode', mode);
  unparkWindow(overlayWindow, { focus });
  // Re-asserting an already-set topmost flag still round-trips through
  // SetWindowPos and can blink the window — only touch it when it dropped.
  if (!overlayWindow.isAlwaysOnTop()) overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlay() {
  clearTimeout(tooltipTimer);
  overlayMode = null;
  parkWindow(overlayWindow);
}

function openPanel() {
  clearTimeout(tooltipTimer);
  registry.markAllRead();
  openedAt = Date.now();
  showOverlay('panel', { focus: true });
}

function showTooltip() {
  if (overlayMode === 'panel') return;
  showOverlay('tooltip');
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(hideOverlay, TOOLTIP_HIDE_MS);
}

ipcMain.on('overlay:toggle-panel', () => {
  log('panel toggle requested');
  if (overlayMode === 'panel') {
    // Collapsing on the bubble dismisses the whole ensemble, settings included.
    closeSettingsWindow();
    return hideOverlay();
  }
  if (Date.now() - closedByBlurAt < JUST_CLOSED_MS) return;
  openPanel();
});
ipcMain.on('overlay:open-panel', () => openPanel());
ipcMain.on('overlay:close', () => {
  log('overlay close requested');
  hideOverlay();
});

// --- settings window: its own modal, living beside the panel -------------
// Sized like the panel is: the base box scaled by the same panelScale, with
// the zoom following, so the settings text tracks the size the user picked.
// The settings read better a notch larger than the panel, so the old 120%
// is the new 100%: this boost multiplies both the box and the zoom.
const SETTINGS_SIZE = { width: 640, height: 480 };
const SETTINGS_ZOOM = 1.2;
let settingsOpenedAt = 0;

// Logical state, not isVisible(): a parked window still counts as visible
// to the OS.
let settingsShown = false;

function settingsVisible() {
  return Boolean(settingsWindow && !settingsWindow.isDestroyed() && settingsShown);
}

function settingsBounds() {
  const factor = panelScale() * SETTINGS_ZOOM;
  const anchor = bubbleAnchor ?? { x: 0, y: 0 };
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  const width = Math.min(Math.round(SETTINGS_SIZE.width * factor), workArea.width);
  const height = Math.min(Math.round(SETTINGS_SIZE.height * factor), workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function openSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsOpenedAt = Date.now();
  applyZoom(settingsWindow, panelScale() * SETTINGS_ZOOM);
  // Every open recenters — a drag holds only while the window stays up.
  // Already visible means a live scale change: resize in place instead.
  if (canPositionWindows) {
    if (settingsVisible()) resizeSettingsInPlace();
    else applyBounds(settingsWindow, settingsBounds());
  }
  settingsShown = true;
  unparkWindow(settingsWindow, { focus: true });
  if (!settingsWindow.isAlwaysOnTop()) settingsWindow.setAlwaysOnTop(true, 'screen-saver');
}

// A visible non-resizable window swallows programmatic resizes on Windows
// (hidden ones take them, which is why reopening used to fix the size) —
// resizable flips on just for the operation.
function resizeSettingsInPlace() {
  const { width, height } = settingsBounds();
  const wasResizable = settingsWindow.isResizable();
  if (!wasResizable) settingsWindow.setResizable(true);
  const { x, y } = settingsWindow.getBounds();
  settingsWindow.setBounds({ x, y, width, height });
  if (!wasResizable) settingsWindow.setResizable(false);
}

function closeSettingsWindow({ refocusPanel = false } = {}) {
  if (!settingsVisible()) return;
  settingsShown = false;
  parkWindow(settingsWindow);
  // Hand focus back to the panel when it is still up, so its own blur cycle
  // re-arms — otherwise the next outside click would have no blur to fire.
  if (refocusPanel && overlayMode === 'panel' && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus();
  }
}

ipcMain.on('settings:open', () => openSettingsWindow());
ipcMain.on('settings:close', () => closeSettingsWindow({ refocusPanel: true }));

function bubbleVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function hideToTray() {
  hideOverlay();
  closeSettingsWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  refreshTrayMenu();
}

function showBubble() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  refreshTrayMenu();
}

// Points at the bubble with a sonar pulse, leaving it exactly where the user
// put it. Only a bubble with nowhere to point AT — never placed, or saved on a
// display that went away — gets moved to the middle of the display under the
// cursor. On Wayland the app cannot position windows, so there it only shows
// and pulses in place.
// The halo window is bigger than the rings on purpose: the glow spreads ~20px
// past the ring and a tight window would slice it into a square on dark
// backgrounds.
const SPOT_BOX = 220;
const SPOT_MS = 2400;
let spotlightTimer = null;

// Notification waves (gentle halo): green = task done, yellow = question or
// waiting, red = permission ask. Fixed colors on purpose — this is a traffic
// light, not a theme accent.
const HALO_COLORS = { done: '#3ecf8e', question: '#e0b341', permission: '#e05561' };
let haloActive = null;
// Every halo decision bumps the generation; an async show that awakes to find
// a newer generation aborts instead of resurrecting a window that a hide (or
// a newer show) already superseded — the race left ghost rings on screen.
let haloGeneration = 0;

// The halo sits ON TOP of the bubble (override-redirect, outside the WM):
// if its input region is not empty the bubble is unclickable. On Electron 42
// / X11 the empty region is FLAKY across remaps — sometimes it survives a
// hide/show, sometimes it comes back full. So the window is never remapped
// once shown (ring visibility is pure CSS), the region is re-asserted after
// every geometry change, and a 1s guard keeps re-asserting while rings are
// visible — never trust the one set at creation.
function presentHaloWindow() {
  // macOS ghosts when a visible transparent window moves — reposition hidden
  // there. On Linux it is the OPPOSITE: remapping is what breaks the input
  // region, so the window moves while mapped.
  if (process.platform === 'darwin' && spotlightWindow.isVisible()) spotlightWindow.hide();
  spotlightWindow.setBounds(spotlightBounds(bubbleAnchor, BUBBLE_BOX, SPOT_BOX));
  if (!spotlightWindow.isVisible()) spotlightWindow.showInactive();
  spotlightWindow.setIgnoreMouseEvents(true);
  stayOnTop(spotlightWindow);
  stayOnTop(mainWindow); // the bubble itself stays above its halo
}

function setHaloClasses(mode) {
  const script =
    mode === ''
      ? `document.body.classList.remove('gentle', 'flash');`
      : `document.body.classList.remove('gentle', 'flash');
         document.body.classList.add(${JSON.stringify(mode)});`;
  return spotlightWindow.webContents.executeJavaScript(script).catch(() => {});
}

setInterval(() => {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    spotlightWindow.setIgnoreMouseEvents(true);
  }
}, 1000);

async function showGentleHalo(state, generation) {
  await spotlightWindow.webContents.executeJavaScript(
    `document.body.classList.remove('flash');
     document.body.classList.add('gentle');
     document.body.style.setProperty('--ring', ${JSON.stringify(HALO_COLORS[state])});`,
  );
  if (generation !== haloGeneration) return; // superseded while awaiting
  presentHaloWindow();
}

// Keeps the waves in sync with the sessions: called on every registry change
// and whenever the bubble settles somewhere new. The find-the-bubble flash
// borrows the window and hands it back through here.
function updateNotificationHalo() {
  const state = haloState(registry.list());
  const positionable = canPositionWindows && Boolean(bubbleAnchor);
  sendToRenderer('halo', { state: positionable ? null : state });
  if (spotlightTimer) return; // a find-the-bubble flash is running — after it
  const wanted = state && positionable ? state : null;
  if (wanted === haloActive) return; // already waving right — no show churn
  haloActive = wanted;
  haloGeneration += 1;
  if (!spotlightWindow || spotlightWindow.isDestroyed()) return;
  if (!haloActive) {
    setHaloClasses(''); // rings off; the window stays mapped (see above)
    return;
  }
  showGentleHalo(haloActive, haloGeneration).catch((error) => log(`halo failed: ${error}`));
}

// The halo rides in its own click-through window: the bubble window is
// exactly bubble-sized and clips any glow into a square. The ring colour is
// read live from the bubble's CSS so every theme keeps its own accent.
async function flashSpotlight() {
  if (!spotlightWindow || spotlightWindow.isDestroyed() || !bubbleAnchor) return;
  try {
    haloGeneration += 1; // abort any gentle show still in flight
    const accent = await mainWindow.webContents.executeJavaScript(
      "getComputedStyle(document.body).getPropertyValue('--accent')",
    );
    await spotlightWindow.webContents.executeJavaScript(
      `document.body.classList.remove('gentle');
       document.body.classList.add('flash');
       document.body.style.setProperty('--ring', ${JSON.stringify(String(accent).trim())})`,
    );
    presentHaloWindow();
    haloActive = null; // the flash wiped the gentle mode — hand-back re-shows
    clearTimeout(spotlightTimer);
    spotlightTimer = setTimeout(() => {
      spotlightTimer = null;
      setHaloClasses(''); // rings off, window stays mapped
      updateNotificationHalo(); // hand the window back to the waves
    }, SPOT_MS);
  } catch (error) {
    log(`spotlight failed: ${error}`);
  }
}

function findBubble() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showBubble();
  if (canPositionWindows) {
    const cursor = screen.getCursorScreenPoint();
    const found = findBubbleAnchor({
      anchor: bubbleAnchor,
      displays: screen.getAllDisplays(),
      cursorWorkArea: screen.getDisplayNearestPoint(cursor).workArea,
      box: BUBBLE_BOX,
    });
    bubbleAnchor = found.anchor;
    if (found.moved) {
      mainWindow.setPosition(bubbleAnchor.x, bubbleAnchor.y);
      persistAnchor();
      if (overlayMode) showOverlay(overlayMode, { focus: overlayMode === 'panel' });
    }
    flashSpotlight();
  }
  stayOnTop(mainWindow);
  sendToRenderer('ui:spotted');
}

// Registers the configured global shortcuts, dropping whatever was bound
// before. Failures (combo taken by the system, or a Wayland compositor that
// refuses global shortcuts) are reported through state so the settings panel
// can say which ones did not take — the tray menu stays the fallback.
let shortcutFailures = [];

function applyShortcuts() {
  globalShortcut.unregisterAll();
  const actions = {
    panel: () => {
      if (overlayMode === 'panel') {
        hideOverlay();
        return;
      }
      showBubble();
      openPanel();
    },
    bubble: () => (bubbleVisible() ? hideToTray() : showBubble()),
    find: findBubble,
    chat: () => {
      showBubble();
      openPanel();
      sendToRenderer('ui:open-chat');
    },
  };
  shortcutFailures = [];
  for (const [id, accelerator] of Object.entries(managerConfig.shortcuts ?? {})) {
    if (!accelerator || !actions[id]) continue;
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, actions[id]);
    } catch {
      registered = false;
    }
    if (!registered) shortcutFailures.push(id);
  }
  if (shortcutFailures.length) log(`shortcuts not registered: ${shortcutFailures.join(', ')}`);
}

function refreshTrayMenu() {
  if (!tray) return;
  const actions = {
    panel: () => {
      showBubble();
      openPanel();
    },
    settings: () => openSettingsWindow(),
    toggle: () => (bubbleVisible() ? hideToTray() : showBubble()),
    find: findBubble,
    quit: () => app.quit(),
  };
  const template = trayMenuTemplate({ bubbleVisible: bubbleVisible() }).map((item) =>
    item.id ? { ...item, click: actions[item.id] } : item,
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// Hiding into the tray is only offered where an icon can actually appear.
// GNOME without the appindicator extension has no host, and hiding there would
// leave no bubble, no menu and no way back — so the button keeps quitting.
async function setupTray() {
  const available = await detectTrayHost({ platform: process.platform, execFn: execFileAsync });
  if (!available) {
    const needsExtension = shouldInstallTraySupport({
      platform: process.platform,
      desktop: process.env.XDG_CURRENT_DESKTOP,
      hasTrayHost: false,
    });
    if (!needsExtension) {
      log('tray: this session has no tray — close keeps quitting for real');
      return;
    }
    // GNOME only loads an extension at startup, so the icon can never show up
    // in the session that installed it: say so instead of looking broken.
    const result = await installTraySupport({ execFn: execFileAsync, log }).catch((error) => {
      log(`tray support install failed: ${error}`);
      return null;
    });
    trayNeedsRelogin = Boolean(result);
    sendState();
    return;
  }
  tray = new Tray(trayIconPath);
  tray.setToolTip('Vizor');
  // GNOME's appindicator has no activate signal — a left click just opens the
  // menu — so the menu carries every action instead of relying on this.
  tray.on('click', () => {
    showBubble();
    openPanel();
  });
  refreshTrayMenu();
  sendState();
}

ipcMain.on('app:quit', () => (tray ? hideToTray() : app.quit()));


const windowOptions = {
  icon: iconPath,
  frame: false,
  transparent: true,
  // resizable stays true because resizable:false breaks -webkit-app-region
  // drag on Linux.
  resizable: true,
  // Double-clicking a drag region maximizes a frameless window, and the
  // layouts only exist at their fixed sizes. Linux ignores this flag, so
  // createWindows also snaps back on the maximize event.
  maximizable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: false,
  // backgroundThrottling: false — a hidden window otherwise gets its
  // compositing suspended, and show() flashes an empty frame before the
  // renderer wakes up (most visible on Windows with transparent windows).
  webPreferences: { preload: preloadPath, contextIsolation: true, backgroundThrottling: false },
};

// visibleOnFullScreen turns the app into an accessory on macOS (no dock
// icon), which is why the panel carries its own quit action.
// Dropped while a package installs: the system asks for a password in its own
// dialog, and a screen-saver-level overlay would sit on top of it — the user
// would see the prompt but never reach it.
let floatAboveEverything = true;

function stayOnTop(win) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(floatAboveEverything, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function setFloatAboveEverything(enabled) {
  if (floatAboveEverything === enabled) return;
  floatAboveEverything = enabled;
  for (const win of [mainWindow, overlayWindow, settingsWindow]) stayOnTop(win);
}

function createWindows() {
  // A saved anchor from a display that no longer exists (unplugged monitor)
  // would boot the bubble off screen with nothing to grab — fall back instead.
  const persisted = loadPersistedState().bubble;
  const saved = anchorVisible(persisted, screen.getAllDisplays(), BUBBLE_BOX) ? persisted : null;
  const workArea = screen.getPrimaryDisplay().workArea;
  bubbleAnchor = {
    x: saved?.x ?? workArea.x + workArea.width - BUBBLE_BOX - 24,
    y: saved?.y ?? workArea.y + Math.round(workArea.height * 0.45),
  };

  mainWindow = new BrowserWindow({
    ...windowOptions,
    width: BUBBLE_BOX,
    height: BUBBLE_BOX,
    ...(canPositionWindows ? { x: bubbleAnchor.x, y: bubbleAnchor.y } : {}),
  });
  mainWindow.setMinimumSize(BUBBLE_BOX, BUBBLE_BOX);
  mainWindow.setMaximumSize(BUBBLE_BOX, BUBBLE_BOX);
  stayOnTop(mainWindow);
  mainWindow.loadFile(path.join(rendererDir, 'app.html'), { query: { view: 'bubble' } });
  mainWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('ui:env', { managed: canPositionWindows });
    sendState();
  });

  spotlightWindow = new BrowserWindow({
    ...windowOptions,
    width: SPOT_BOX,
    height: SPOT_BOX,
    show: false,
    focusable: false,
  });
  // pure halo: never focus, never swallow a click on whatever sits behind it
  spotlightWindow.setIgnoreMouseEvents(true);
  spotlightWindow.loadFile(path.join(rendererDir, 'spotlight.html'));

  overlayWindow = new BrowserWindow({
    ...windowOptions,
    width: MODE_SIZES.panel.width,
    height: MODE_SIZES.panel.height,
    show: false,
  });
  stayOnTop(overlayWindow);
  overlayWindow.loadFile(path.join(rendererDir, 'app.html'), { query: { view: 'overlay' } });
  // The overlay needs its own env send: the bubble's did-finish-load can fire
  // before this window listens, and without it the body misses the .managed
  // class — the whole panel becomes a drag region, where a double click
  // maximizes the window.
  overlayWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('ui:env', { managed: canPositionWindows });
    sendState();
  });
  bornParked(overlayWindow);

  settingsWindow = new BrowserWindow({
    ...windowOptions,
    width: Math.round(SETTINGS_SIZE.width * SETTINGS_ZOOM),
    height: Math.round(SETTINGS_SIZE.height * SETTINGS_ZOOM),
    show: false,
    // Frameless + resizable grows grab-borders on Windows/macOS, which is the
    // only "resize" this fixed layout could ever offer — drop them. Linux
    // keeps resizable: true because false breaks -webkit-app-region drag.
    resizable: process.platform === 'linux',
    // Chromium keys file:// zoom per origin and shares it across windows, so
    // the settings boost would leak into the bubble and the panel (they load
    // the same app.html). Its own partition gives it a zoom map of its own.
    webPreferences: { ...windowOptions.webPreferences, partition: 'vizor-settings' },
  });
  stayOnTop(settingsWindow);
  settingsWindow.loadFile(path.join(rendererDir, 'app.html'), { query: { view: 'settings' } });
  settingsWindow.webContents.on('did-finish-load', () => {
    sendToRenderer('ui:env', { managed: canPositionWindows });
    sendState();
  });
  bornParked(settingsWindow);

  // Focus bounces back to the bubble window right after a click, so a bare
  // blur is not enough: the panel only closes when no window of ours is
  // focused any more — that is, when the click really landed outside.
  // Linux ignores maximizable: false, so a double click on a drag region (the
  // whole body on Wayland, by design) can still maximize — undo it on the spot.
  for (const win of [mainWindow, overlayWindow, settingsWindow]) {
    win.on('maximize', () => win.unmaximize());
  }

  // Dragging the settings by their header runs inside a system move loop
  // where none of our windows reports focus — the cursor riding on the
  // settings window is the tell that this is not an outside click.
  const cursorOnSettings = () => {
    if (!settingsVisible()) return false;
    const bounds = settingsWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    return (
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height
    );
  };

  // A click outside every window of ours dismisses the whole ensemble: the
  // panel and the settings go together, while clicks hopping between them
  // keep both up (some window of ours is focused again by the time we look).
  const closeOnOutsideClick = () => {
    setTimeout(() => {
      const ours = [mainWindow, overlayWindow, settingsWindow].some(
        (win) => win && !win.isDestroyed() && win.isFocused(),
      );
      if (ours || cursorOnSettings()) return;
      if (overlayMode === 'panel') {
        hideOverlay();
        closedByBlurAt = Date.now();
      }
      closeSettingsWindow();
    }, 120);
  };

  overlayWindow.on('blur', () => {
    if (overlayMode !== 'panel' || Date.now() - openedAt < SETTLE_MS) return;
    closeOnOutsideClick();
  });
  settingsWindow.on('blur', () => {
    if (!settingsVisible() || Date.now() - settingsOpenedAt < SETTLE_MS) return;
    closeOnOutsideClick();
  });
}

async function generateVoiceForStop(session) {
  const snapshot = session.transcriptPath
    ? await readTranscriptSnapshot(session.transcriptPath)
    : { lastAssistantMessage: null, pendingQuestion: null };
  // A Stop can itself end on a question ("which option do you want?"), so a
  // pending ask found here is shown too instead of being discarded.
  registry.setQuestion(session.id, snapshot.pendingQuestion);
  registry.setLastMessage(session.id, digestMessage(snapshot.lastAssistantMessage));
  let voice;
  if (isEconomyMode()) {
    voice = fallbackMessage(displayNameOf(session));
  } else {
    voice = await generateManagerMessage({
      projectName: displayNameOf(session),
      lastAssistantMessage: snapshot.lastAssistantMessage,
    });
    tokenBudget.add(voice.tokensUsed);
  }
  registry.setManagerMessage(session.id, voice);
  if (await allowAnnouncement(session, 'done', voice.message)) {
    sendToRenderer('tooltip', { projectName: displayNameOf(session), text: voice.message, kind: 'done' });
    showTooltip();
  }
}

// The Notification hook often fires BEFORE Claude Code flushes the ask entry
// to the transcript — reading immediately misses the question and the card
// shows no options. Retry a few times before giving up.
const QUESTION_RETRY_DELAYS_MS = [0, 600, 1500];

async function readSnapshotWithQuestionRetry(transcriptPath) {
  let snapshot = { lastAssistantMessage: null, pendingQuestion: null };
  for (const delayMs of QUESTION_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    snapshot = await readTranscriptSnapshot(transcriptPath);
    if (snapshot.pendingQuestion) return snapshot;
  }
  return snapshot;
}

async function enrichNotification(session) {
  const snapshot = session.transcriptPath
    ? await readSnapshotWithQuestionRetry(session.transcriptPath)
    : { pendingQuestion: null };
  registry.setQuestion(session.id, snapshot.pendingQuestion);
  const firstQuestion = snapshot.pendingQuestion?.questions?.[0];
  // The card shows exactly what the tooltip showed — one message per chat.
  const text = firstQuestion?.question ?? session.managerMessage;
  if (!text) return;
  if (firstQuestion) registry.setManagerMessage(session.id, { message: text });
  const kind = firstQuestion ? 'question' : 'waiting';
  if (await allowAnnouncement(session, kind, text)) {
    sendToRenderer('tooltip', {
      projectName: displayNameOf(session),
      text,
      kind,
      optionsCount: firstQuestion?.options?.length ?? 0,
    });
    showTooltip();
  }
}

// Edit-tool hooks feed the workspace's edit tracking, never the session
// registry: they say nothing about whether the session is waiting or done.
function onToolEvent(event) {
  const target = event.tool_input?.file_path ?? event.tool_input?.notebook_path ?? '-';
  log(`edit hook: ${event.hook_event_name} ${event.tool_name} ${target} id=${event.tool_use_id ?? '-'}`);
}

function onHookEvent(event) {
  if (event?.hook_event_name === 'PreToolUse' || event?.hook_event_name === 'PostToolUse') {
    onToolEvent(event);
    return;
  }
  if (event?.hook_event_name === 'Notification') {
    event = {
      ...event,
      permissionAsk: isPermissionAsk(event.message),
      message: humanizeNotification(event.message),
    };
  }
  const session = registry.applyEvent(event);
  if (!session) return;
  if (event.hook_event_name === 'Stop') {
    generateVoiceForStop(session).catch((error) => log(`voice generation failed: ${error}`));
  } else if (event.hook_event_name === 'Notification') {
    enrichNotification(session).catch((error) => log(`notification enrich failed: ${error}`));
  } else if (event.hook_event_name === 'UserPromptSubmit') {
    sendToRenderer('chime', { kind: 'start' });
  }
}

ipcMain.on('panel:opened', () => registry.markAllRead());

ipcMain.on('session:remove', (_event, sessionId) => registry.remove(sessionId));

// Renaming a chat also becomes the folder's default nickname, so the next
// chat in that folder is born with it (and can be renamed over). Clearing
// the alias clears both.
ipcMain.on('session:rename', (_event, { sessionId, alias }) => {
  const session = registry.sessions.get(sessionId);
  if (!session) return;
  const clean = String(alias ?? '').trim().slice(0, 60);
  registry.setAlias(sessionId, clean);
  const folderAliases = { ...managerConfig.folderAliases };
  if (session.cwd) {
    if (clean) folderAliases[session.cwd] = clean;
    else delete folderAliases[session.cwd];
  }
  managerConfig = { ...managerConfig, folderAliases };
  saveConfig(configFile, managerConfig);
  sendState();
});

// The panel's rescan: adopt the live interactive chats the hooks never
// reported — opened before the manager was up, or closed on the ✕.
ipcMain.handle('sessions:rescan', () => {
  const records = readAdoptableSessions();
  if (!records) return 0;
  return registry.adopt(
    records.map((record) => {
      const transcriptPath = claudeTranscriptPath(record.cwd, record.sessionId);
      return { ...record, transcriptPath: fs.existsSync(transcriptPath) ? transcriptPath : null };
    }),
  );
});

ipcMain.on('update:apply', applyUpdate);

ipcMain.handle('bridge:status', async () => ({
  ...(await bridgeStatus()),
  relevant: process.platform === 'linux' && !displayMode.canInjectInput,
}));
ipcMain.handle('bridge:install', async () => {
  const result = await installBridge();
  cachedDriver = null; // re-resolve on the next focus click
  return result;
});
ipcMain.handle('bridge:uninstall', async () => {
  await uninstallBridge();
  cachedDriver = null;
  return {};
});

ipcMain.handle('update:check', async () => {
  const status = await (updaterHandle.check?.() ?? updateStatus);
  return { ...status, currentVersion: app.getVersion() };
});

ipcMain.on('tts:speak', (_event, payload) => {
  const text = String(payload?.text ?? payload ?? '').slice(0, 300);
  if (!text) return;
  const volume = Number.isFinite(payload?.volume) ? payload.volume : 100;
  tts.stopSpeaking();
  try {
    tts.speak(text, { voice: managerConfig.voice, volume });
  } catch (error) {
    log(`tts failed: ${error}`);
  }
});

// --- manager chat (token-frugal: local digest, excerpt only on mention) ---
const CHAT_HISTORY_LIMIT = 12;
const chatHistory = [];

const ECONOMY_CHAT_REPLY =
  'Atingi o limite de tokens de hoje que você definiu 😴 Sobe a barrinha nas configurações se quiser que eu volte a pensar.';

ipcMain.handle('manager:chat', async (_event, rawMessage) => {
  const userMessage = String(rawMessage ?? '').trim().slice(0, 1000);
  if (!userMessage) return '';
  if (isEconomyMode()) return ECONOMY_CHAT_REPLY;
  const sessions = listWithDisplayNames();
  const mentioned = findMentionedSession(sessions, userMessage);
  const transcriptExcerpt = mentioned?.transcriptPath
    ? (await readTranscriptSnapshot(mentioned.transcriptPath)).lastAssistantMessage
    : null;
  const { reply, tokensUsed } = await askManager({
    sessions,
    history: chatHistory,
    userMessage,
    transcriptExcerpt,
  });
  tokenBudget.add(tokensUsed);
  sendState();
  chatHistory.push({ role: 'user', text: userMessage }, { role: 'manager', text: reply });
  while (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.shift();
  return reply;
});

ipcMain.handle('config:get', () => ({
  ...managerConfig,
  terminals: Object.entries(terminal.TERMINALS).map(([value, spec]) => ({
    value,
    label: spec.label,
  })),
  voices: Object.entries(VOICES).map(([value, spec]) => ({ value, label: spec.label })),
  themes: Object.entries(THEMES).map(([value, spec]) => ({ value, label: spec.label })),
  palettes: Object.entries(PALETTES).map(([value, spec]) => ({ value, label: spec.label })),
  panelScaleRange: PANEL_SCALE,
}));

ipcMain.handle('config:set', (_event, partial) => {
  const allowed = {};
  if (typeof partial?.terminal === 'string') allowed.terminal = partial.terminal;
  if (typeof partial?.voice === 'string' && VOICES[partial.voice]) allowed.voice = partial.voice;
  if (typeof partial?.theme === 'string' && THEMES[partial.theme]) allowed.theme = partial.theme;
  if (typeof partial?.palette === 'string' && PALETTES[partial.palette]) {
    allowed.palette = partial.palette;
  }
  if (Number.isFinite(partial?.panelScale)) allowed.panelScale = clampScale(partial.panelScale);
  if (typeof partial?.crt === 'boolean') allowed.crt = partial.crt;
  if (typeof partial?.autoUpdate === 'boolean') allowed.autoUpdate = partial.autoUpdate;
  if (typeof partial?.announceWhenFocusUnknown === 'boolean')
    allowed.announceWhenFocusUnknown = partial.announceWhenFocusUnknown;
  if (typeof partial?.muted === 'boolean') allowed.muted = partial.muted;
  if (typeof partial?.ttsEnabled === 'boolean') allowed.ttsEnabled = partial.ttsEnabled;
  if (typeof partial?.timbre === 'string') allowed.timbre = partial.timbre;
  for (const key of ['soundVolume', 'voiceVolume']) {
    if (Number.isFinite(partial?.[key])) allowed[key] = Math.min(100, Math.max(0, Math.round(partial[key])));
  }
  if (partial?.typeVolumes && typeof partial.typeVolumes === 'object') {
    allowed.typeVolumes = { ...managerConfig.typeVolumes, ...partial.typeVolumes };
  }
  if (Number.isFinite(partial?.tokenBudgetDaily)) {
    allowed.tokenBudgetDaily = Math.max(0, Math.round(partial.tokenBudgetDaily));
  }
  if (partial?.shortcuts && typeof partial.shortcuts === 'object') {
    allowed.shortcuts = sanitizeShortcuts(partial.shortcuts, managerConfig.shortcuts);
  }
  // Not config state: the OS holds the truth, so the flag is applied and
  // re-read instead of saved.
  if (typeof partial?.autostart === 'boolean') {
    try {
      setAutostart(partial.autostart);
    } catch (error) {
      log(`autostart toggle failed: ${error}`);
    }
  }
  managerConfig = { ...managerConfig, ...allowed };
  try {
    saveConfig(configFile, managerConfig);
  } catch (error) {
    log(`config save failed: ${error}`);
  }
  sendState();
  if (allowed.panelScale && overlayMode === 'panel') showOverlay('panel', { focus: true });
  if (allowed.panelScale && settingsVisible()) openSettingsWindow();
  // Speaking the sample also pulls the model when it is not there yet.
  if (allowed.voice) tts.speak('Voz trocada. Agora eu falo assim!', { voice: allowed.voice });
  if (allowed.shortcuts) {
    applyShortcuts();
    sendState(); // failures are only known after the re-register
  }
  // Turning TTS on is the moment the voice starts being needed — download it
  // now instead of on the first spoken line.
  if (allowed.ttsEnabled === true) tts.predownloadVoice(managerConfig.voice);
  return managerConfig;
});

// Remembers the exact window title each session was last found under, so the
// next hunt hits it instantly instead of cycling tabs again.
const matchedTitleCache = new Map();

// Remembers WHICH tab (1-based) held each session, so terminals with a "go to
// tab N" shortcut jump straight there instead of walking every tab again.
const tabIndexCache = new Map();

async function sessionSearchKeys(session) {
  // Terminals show the title Claude Code pushes for the session — the same
  // string it stores as the transcript's ai-title — so that is the key most
  // likely to match. Read fresh at hunt time: it survives events the app
  // missed while it was down. Plain shell tabs usually show the cwd, and the
  // remaining keys cover those.
  const aiTitle = session?.transcriptPath ? await readAiTitle(session.transcriptPath) : null;
  return [
    matchedTitleCache.get(session?.id),
    aiTitle,
    session?.projectName,
    session?.title,
    session?.promptPreview,
  ];
}

// Everything the platform module needs to hit the exact tab: the identity the
// hook captured from the session's env, and the live claude pid (its tty is
// how macOS finds the tab in Terminal.app/iTerm2).
function sessionFocusTarget(session) {
  return {
    wave: session?.wave,
    term: session?.term,
    sessionPid: session?.id ? readSessionPid(session.id) : null,
    tabIndex: tabIndexCache.get(session?.id),
    // Warp's own url scheme: the cheapest, most exact route there is.
    openUrl: (url) => shell.openExternal(url),
  };
}

// Exact focus rides on things a fresh setup may not have — and they all fail
// SILENTLY. The first click that misses its tab tells the user what is
// missing. macOS: Accessibility (synthetic keys) and Automation (AppleEvents)
// via the native consent ask — the system Accessibility dialog (which also
// lists the app in the pane), the Automation prompt via a harmless probe, and
// a notification that opens the right panel. Linux: no dialog to raise, so a
// notification names the missing piece (xdotool, kitty remote control).
// Windows: no dialog either — the actionable miss is a terminal hiding its
// tab titles, or PowerShell being unreachable.
// The last hint survives the balloon's 8s: the panel keeps it as a banner
// until the user dismisses it (issue #62 — whoever was away finds it later).
let lastHint = null;

function announceHint(hint) {
  const parts = hintAnnouncement(hint);
  if (!parts) return;
  lastHint = { key: hint.key, title: hint.title, body: hint.body };
  sendToRenderer('tooltip', parts.tooltip);
  showTooltip();
  const note = new Notification(parts.notification);
  if (hint.pane) note.on('click', () => shell.openExternal(hint.pane));
  note.show();
  speakAsManager(parts.speech);
  sendState();
}

ipcMain.on('hint:dismiss', () => {
  lastHint = null;
  sendState();
});

let focusNudgeDone = false;
function nudgeFocusPrereqs(hint, platform) {
  if (!hint) return; // nothing actionable — stay quiet and keep watching
  focusNudgeDone = true;
  log(`${platform} focus hint: ${hint.key}`);
  announceHint(hint);
}

// Ad-hoc signing (issue #58) means every self-update hands macOS a new code
// signature, silently voiding the Accessibility grant while the Settings pane
// keeps a toggled-on entry bound to the DEAD one. On boot: if the grant the
// user gave is gone, wipe this app's stale TCC rows so the fresh ask registers
// one clean entry, then ask again saying exactly what happened.
const grantMemoryFile = path.join(configDir, 'macos-perms.json');

async function renewMacosGrantAfterUpdate() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    const memory = readGrantMemory(grantMemoryFile);
    const nowGranted = systemPreferences.isTrustedAccessibilityClient(false);
    if (accessibilityLostAfterUpdate(memory, nowGranted)) {
      log('macos accessibility lost after update — resetting stale TCC entries');
      await resetAccessibilityEntries('io.github.teixeiramatheus9.vizor');
      systemPreferences.isTrustedAccessibilityClient(true);
      announceHint({
        key: 'macos-grant-renewed',
        title: 'A atualização renovou minha identidade',
        body:
          'O macOS zerou a permissão de Acessibilidade na atualização. ' +
          'Reative o Vizor lá que volto a te levar pra aba certa.',
        speech:
          'A atualização renovou minha identidade no sistema! Me autoriza de novo ' +
          'lá em acessibilidade que eu volto a te levar direto pra aba do chat.',
        pane: ACCESSIBILITY_PANE,
      });
    }
    writeGrantMemory(grantMemoryFile, { accessible: nowGranted });
  } catch (error) {
    log(`macos grant renewal failed: ${error}`);
  }
}

async function nudgeMacosPermissions() {
  focusNudgeDone = true;
  try {
    const accessible = systemPreferences.isTrustedAccessibilityClient(false);
    const automation = await probeSystemEventsAutomation();
    log(`macos permissions: accessibility=${accessible} automation=${automation}`);
    // Keep the on-disk memory fresh: a grant given mid-run must be remembered,
    // or its loss on the NEXT update would go undetected.
    if (app.isPackaged) writeGrantMemory(grantMemoryFile, { accessible });
    if (accessible && automation === 'granted') return;
    if (!accessible) {
      // Start from clean rows: piled-up dead entries leave the pane showing a
      // toggled-on ghost next to the real ask (harmless when there are none).
      if (app.isPackaged) {
        await resetAccessibilityEntries('io.github.teixeiramatheus9.vizor');
      }
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    announceHint({
      key: 'macos-permissions',
      title: 'O gerente precisa de uma permissão',
      body:
        'Pra te levar direto pra aba do chat, ative o Vizor em ' +
        'Acessibilidade (e em Automação) na Privacidade e Segurança.',
      speech:
        'Preciso de uma permissãozinha sua nos ajustes! Libera o acesso pra mim ' +
        'que aí eu te levo direto pra aba do chat.',
      pane: accessible ? AUTOMATION_PANE : ACCESSIBILITY_PANE,
    });
  } catch (error) {
    log(`macos permissions nudge failed: ${error}`);
  }
}

async function huntSessionTab(session) {
  // Timed because a slow hunt is a visible one: the user watches tabs flip.
  const startedAt = Date.now();
  const result = await terminal.focusChatTab(await sessionSearchKeys(session), {
    terminal: managerConfig.terminal,
    allowInputInjection: displayMode.canInjectInput,
    driver: (await windowDriver()).driver,
    ...sessionFocusTarget(session),
  });
  log(`focus ${session?.id?.slice(0, 8)} in ${Date.now() - startedAt}ms: ${JSON.stringify(result)}`);
  if (!result.tabFound && !focusNudgeDone) {
    if (process.platform === 'darwin') nudgeMacosPermissions();
    else if (process.platform === 'linux')
      nudgeFocusPrereqs(
        linuxFocusHint(result, session?.term, {
          canInjectInput: displayMode.canInjectInput,
          bridge: await bridgeStateForHints(),
        }),
        'linux',
      );
    else if (process.platform === 'win32') nudgeFocusPrereqs(win32FocusHint(result), 'win32');
  }
  if (session?.id) {
    if (result.tabFound && result.matchedTitle) {
      matchedTitleCache.set(session.id, result.matchedTitle);
    } else if (!result.tabFound) {
      matchedTitleCache.delete(session?.id);
    }
    if (result.tabFound && result.tabIndex) tabIndexCache.set(session.id, result.tabIndex);
    else if (!result.tabFound) tabIndexCache.delete(session.id);
  }
  return result;
}

ipcMain.handle('warp:focus', (_event, sessionId) => {
  const session = registry.sessions.get(sessionId);
  return huntSessionTab(session);
});

// The mirror view: the conversation this chat had, straight from its
// transcript — same file the Stop handler already reads, so no new source.
ipcMain.handle('transcript:tail', async (_event, sessionId) => {
  const session = registry.sessions.get(sessionId);
  if (!session?.transcriptPath) return [];
  return readConversationTail(session.transcriptPath);
});

ipcMain.handle('warp:answer', async (_event, { sessionId, optionIndex }) => {
  const session = registry.sessions.get(sessionId);
  const index = Number(optionIndex);
  if (!session || !Number.isInteger(index) || index < 0) return 'failed';

  // Sending the option's own text beats simulating Down x N + Return: it needs
  // no window, and it cannot land on the wrong option if the list scrolled.
  const optionText = session.question?.questions?.[0]?.options?.[index];
  const channel = readSessionChannel(session.id);
  if (channel && typeof optionText === 'string' && optionText.trim()) {
    // 'now': the chat is parked on this question, so the answer must not sit
    // behind anything else in its queue.
    const outcome = await sendUserMessage(channel.socketPath, optionText, {
      token: channel.token,
      priority: 'now',
    });
    if (outcome === 'sent') {
      registry.markAnswered(sessionId);
      return 'answered';
    }
    log(`peer channel unusable for answer on ${session.id} (${outcome})`);
  }

  const result = await terminal.answerQuestionInWarp(await sessionSearchKeys(session), index, {
    terminal: managerConfig.terminal,
    allowInputInjection: displayMode.canInjectInput,
    driver: (await windowDriver()).driver,
    ...sessionFocusTarget(session),
  });
  if (result === 'answered') registry.markAnswered(sessionId);
  return result;
});

// Reply path, in order of preference:
// 1. The session's own unix socket — works on Wayland, on any terminal, and
//    cannot deliver to the wrong chat because it is addressed by session id.
// 2. The terminal window (xdotool), for builds where the messaging channel is
//    gated off or the session predates it.
async function replyToSession(session, text) {
  const channel = session?.id ? readSessionChannel(session.id) : null;
  if (channel) {
    // A panel reply is the user reacting to this chat right now — jump the
    // queue instead of waiting for whatever turn is in flight to finish.
    const outcome = await sendUserMessage(channel.socketPath, text, {
      token: channel.token,
      priority: 'now',
    });
    if (outcome === 'sent') return 'sent';
    log(`peer channel unusable for ${session.id} (${outcome}) — falling back to the terminal`);
  }
  return terminal.sendReplyToWarp(await sessionSearchKeys(session), text, {
    writeClipboard: (value) => clipboard.writeText(value),
    terminal: managerConfig.terminal,
    allowInputInjection: displayMode.canInjectInput,
    driver: (await windowDriver()).driver,
    ...sessionFocusTarget(session),
  });
}

ipcMain.handle('warp:reply', async (_event, { sessionId, text }) => {
  const session = registry.sessions.get(sessionId);
  const reply = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!reply) return 'failed';
  return replyToSession(session, reply);
});

// Manual drag (managed/X11 mode only): the renderer reports press/release on
// the bubble; main polls the cursor, moves the window, and tells the
// renderer when a press was really just a click.
ipcMain.on('drag:start', () => {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) setHaloClasses('');
  if (!canPositionWindows || !mainWindow || mainWindow.isDestroyed()) return;
  if (dragState) clearInterval(dragState.timer);
  const startCursor = screen.getCursorScreenPoint();
  const [windowX, windowY] = mainWindow.getPosition();
  dragState = {
    startCursor,
    offset: { x: startCursor.x - windowX, y: startCursor.y - windowY },
    moved: false,
    timer: setInterval(() => {
      const cursor = screen.getCursorScreenPoint();
      const distance =
        Math.abs(cursor.x - dragState.startCursor.x) + Math.abs(cursor.y - dragState.startCursor.y);
      if (distance > CLICK_THRESHOLD_PX) dragState.moved = true;
      if (dragState.moved) {
        mainWindow.setPosition(cursor.x - dragState.offset.x, cursor.y - dragState.offset.y);
      }
    }, 16),
  };
});

ipcMain.on('drag:end', () => {
  if (!dragState) return;
  clearInterval(dragState.timer);
  const wasDragged = dragState.moved;
  dragState = null;
  if (!wasDragged) {
    // A click does not move the bubble, so the halo needs nothing — touching
    // it here raced the panel opening. The breadcrumb makes 'the bubble is
    // dead' reports diagnosable from the log.
    log('bubble click');
    sendToRenderer('ui:click');
    return;
  }
  haloActive = null; // force a re-show at the new spot
  const [x, y] = mainWindow.getPosition();
  const center = { x: x + BUBBLE_BOX / 2, y: y + BUBBLE_BOX / 2 };
  const workArea = screen.getDisplayNearestPoint(center).workArea;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  bubbleAnchor = {
    x: clamp(x, workArea.x, workArea.x + workArea.width - BUBBLE_BOX),
    y: clamp(y, workArea.y, workArea.y + workArea.height - BUBBLE_BOX),
  };
  mainWindow.setPosition(bubbleAnchor.x, bubbleAnchor.y);
  persistAnchor();
  // Moving across displays can drop the window behind others.
  stayOnTop(mainWindow);
  // Only AFTER the anchor above is final: re-showing first left the rings
  // waving at the OLD spot — a blinking decoy the user then clicks on.
  updateNotificationHalo();
  if (overlayMode) showOverlay(overlayMode, { focus: overlayMode === 'panel' });
});

// Self-registers the Claude Code hooks on startup, so packaged installs
// (AppImage/deb/rpm) work out of the box. ELECTRON_RUN_AS_NODE turns this
// app's own binary into the hook runtime — no system Node required.
const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  } catch {
    return {}; // no settings yet — start from empty
  }
}

// Every write backs the file up first: this is the user's global Claude Code
// config, not the app's own.
function writeClaudeSettings(next) {
  if (fs.existsSync(claudeSettingsPath)) {
    fs.copyFileSync(claudeSettingsPath, `${claudeSettingsPath}.vizor-${Date.now()}.bak`);
  }
  fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
  fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

function removeHooksInstalled() {
  try {
    const settings = readClaudeSettings();
    const next = removeAppHooks(settings);
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    writeClaudeSettings(next);
    log('hooks removed on quit');
  } catch (error) {
    log(`removeHooksInstalled failed: ${error}`);
  }
}

function ensureHooksInstalled() {
  try {
    const hookScript = path.join(currentDir, '..', 'hook', 'hook-emit.js');
    const { command, shim } = buildHookCommand({
      platform: process.platform,
      execPath: process.execPath,
      hookScript,
      shimDir: configDir,
    });
    if (shim) {
      fs.mkdirSync(path.dirname(shim.path), { recursive: true });
      fs.writeFileSync(shim.path, shim.content);
    }
    const settings = readClaudeSettings();
    const next = ensureHooks(settings, command);
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    writeClaudeSettings(next);
    log(`hooks self-installed: ${command}`);
  } catch (error) {
    log(`ensureHooksInstalled failed: ${error}`);
  }
}

// crossSessionInbound decides what a session does with the quick reply this app
// sends. It lives in the user's Claude Code settings, so the app only ever
// writes the user level — a repo or managed setting can still tighten it, and
// the panel says so instead of promising an outcome.
ipcMain.handle('inbound:get', () => readInboundPolicy(readClaudeSettings()));

ipcMain.handle('inbound:set', (_event, value) => {
  const settings = readClaudeSettings();
  const next = setInboundPolicy(settings, value);
  if (!next) {
    log(`inbound policy refused: ${value}`);
    return readInboundPolicy(settings);
  }
  try {
    writeClaudeSettings(next);
    log(`crossSessionInbound set to ${value}`);
  } catch (error) {
    log(`inbound policy write failed: ${error}`);
    return readInboundPolicy(settings);
  }
  return readInboundPolicy(next);
});

// Read once, then forget: a note left by a version that never came back would
// otherwise be spoken on every launch.
function announceUpdateIfJustInstalled() {
  let mark = null;
  try {
    mark = JSON.parse(fs.readFileSync(updateNoticeFile, 'utf8'));
    fs.rmSync(updateNoticeFile, { force: true });
  } catch {
    return;
  }
  if (!shouldAnnounce(mark, app.getVersion())) return;
  speakAsManager(UPDATE_DONE_PHRASE);
}

function hydrateRegistry() {
  try {
    registry.hydrate(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')));
    registry.prune();
  } catch {
    // first run or corrupt file — start fresh
  }
}

// Drops the sessions whose terminal was closed: they never send a hook on the
// way out, so without this they linger frozen on their last status.
function reapDeadSessions() {
  registry.reconcileLiveSessions(readLiveSessionIds());
}

let saveTimer = null;
function scheduleSessionsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(sessionsFile, JSON.stringify(registry.serialize()));
    } catch (error) {
      log(`sessions save failed: ${error}`);
    }
  }, 500);
}

// A second instance would unlink and take over the unix socket, leaving the
// first one running but unreachable by the hooks.
if (!app.requestSingleInstanceLock()) app.exit(0);

app.whenReady().then(() => {
  if (relaunchUnderX11IfNeeded()) return;
  log(
    `display mode: platform=${displayMode.platform} managed=${displayMode.managed} `.concat(
      `canInjectInput=${displayMode.canInjectInput}`,
    ),
  );
  tts.watchDownloads(() => sendState());
  // A fresh session otherwise meets the system fallback voice on the first
  // spoken line. Delayed so the boot (windows, tray, socket) settles first.
  setTimeout(
    () => tts.predownloadVoice(managerConfig.voice, { enabled: managerConfig.ttsEnabled }),
    10_000,
  );
  announceUpdateIfJustInstalled();
  renewMacosGrantAfterUpdate();
  ensureHooksInstalled();
  autoSetupBridgeOnWayland();
  hydrateRegistry();
  reapDeadSessions();
  createWindows();
  socketServer = startSocketServer(socketPath, onHookEvent, log);
  setupTray();
  registry.on('change', sendState);
  registry.on('change', updateNotificationHalo);
  registry.on('change', scheduleSessionsSave);
  setInterval(() => registry.prune(), PRUNE_INTERVAL_MS);
  setInterval(reapDeadSessions, LIVENESS_INTERVAL_MS);
  updaterHandle = setupUpdater({ onStatus: onUpdateStatus, log });
  applyShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  // with a tray icon the app lives on with every window hidden
  if (!tray) app.quit();
});

app.on('before-quit', () => {
  // closing for real means the hooks stop firing too — parking in the tray is
  // not closing, so they stay while the app watches from there
  removeHooksInstalled();
  tts.stopSpeaking();
  killPendingClaude();
  stopSocketServer(socketServer, socketPath);
  tray?.destroy();
  tray = null;
});
