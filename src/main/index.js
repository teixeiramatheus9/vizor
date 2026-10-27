import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHookCommand, ensureGuard, ensureHooks, removeAppHooks, removeGuard } from '../../scripts/install-hooks.js';
import { guardCommand, installGuardScript } from './guard-runtime.js';
import { createGuardAsks, isGuardChoice } from './guard-asks.js';
import { createRulesStore, pruneSeenSessions } from './rules-store.js';
import { guardSpeech } from '../renderer/guard-card.js';
import { normalizeMic, normalizeMicList } from '../renderer/mic-choice.js';
import { chromiumSinkId, listSinks, normalizeOutput } from './audio-devices.js';
import { Worker } from 'node:worker_threads';
import { createListener } from './voice/listener.js';
import { createSpeechArbiter } from './voice/arbiter.js';
import { createVoiceSession } from './voice/session.js';
import { createRoutines } from './voice/routines.js';
import { createNarrator } from './voice/narration.js';
import { buildOrchestra, nextFocus } from './maestro/orchestra.js';
import { createPendingOrder } from './maestro/pending-order.js';
import { createGraphIndexer, createWorkerParser } from './graph/indexer.js';
import { impactOf, parsePlan, touchedFunctions } from './graph/impact.js';
import { createConductor } from './maestro/conductor.js';
import { createBackstage, descendantsOf, parseListeners, portsFor } from './maestro/backstage.js';
import { excludeWithPlan, isPlanEdit } from './work/plan.js';
import { createPlanActions, createPlanTracker } from './work/plans.js';
import { catalogFrom, catalogStale } from './work/catalog.js';
import { reviewPrPrompt, startIssuePrompt, taskTabTitle } from './work/prompts.js';
import { readTail } from './maestro/log-tail.js';
import { shouldSuggest } from './maestro/reviewer.js';
import { criticalOf } from '../renderer/graph-view.js';
import { testOutcomeOf } from './voice/narration.js';
import { createVocabularyStore, scanVocabulary } from './voice/vocabulary.js';
import { avatarOwnerOf, createAvatarService } from './project-avatar.js';
import { fetchImage as fetchAvatarImage } from './avatar-fetch.js';
import { buildDigest, ghQueries, githubRepoOf, managerContext, resolveProject } from './voice/gh-digest.js';
import { createTaskLinks, resolveTask } from './voice/task-links.js';
import { safeToTypeIdle } from './bubble-routing.js';
import { runClaude } from './claude-cli.js';
import { ASR_MODELS, KWS_MODEL, VAD_MODEL, installVoiceModels, missingVoiceModels, voiceModelPaths } from './voice/models.js';
import { otherRecorders, parsePwDump } from './voice/meeting.js';
import { evaluate, gitContextOf, loadRules } from '../hook/rule-guard.js';
import { compileRules, editProblem, validateEditedRule } from './rules-compiler.js';
import { SessionRegistry, displayName, haloState } from './session-registry.js';
import { startSocketServer, stopSocketServer } from './socket-server.js';
import {
  readAiTitle,
  readConversationTail,
  readEditReason,
  readLastBashCommand,
  readFirstPrompt,
  readInterrupted,
  readTranscriptSnapshot,
} from './transcript.js';
import { createHash } from 'node:crypto';
import { createReviewService } from './review/service.js';
import { createReviewStore, storeKey } from './review/review-store.js';
import { createVerifier } from './review/verify.js';
import { composeMessage, rejectNotice } from './review/compose.js';
import { safeRelPath, sanitizePrefs } from './review/ipc-guard.js';
import { EditTracker } from './edit-tracker.js';
import { createEditPipeline } from './edit-pipeline.js';
import { readIndexVersion } from './git-files.js';
import { MAX_DIFF_BYTES, diffability } from './edit-hunks.js';
import { createCommandWatcher } from './command-watcher.js';
import { listWorktrees, repoRootOf, worktreeRootOf } from './worktrees.js';
import {
  addProject,
  buildWorkspaceTree,
  quitPrompt,
  removeProject,
  removedIds,
  clampTerminalSize,
  matchWorktree,
  shouldAutoAdd,
  staleRoots,
  workspaceAvailable,
} from './workspace-model.js';
import { boundsVisible, createWorkspaceWindowManager } from './workspace-window.js';
import { loadPty } from './pty-loader.js';
import { createPtyHost, withoutClaudeSession } from './pty-host.js';
import { createQuitFreeze, linkTerminals, restorePlan, tabsToSave, terminalCommand, trackChatEnds, isSessionId } from './workspace-tabs.js';
import { listConversations, resolveClaudeProjectDir } from './conversations.js';
import { commandReason, fileViewFor, serializeTask, taskSummaries } from './edit-view.js';
import { bracketedPaste, buildCommentMessage, validateComment } from './comment-message.js';
import { createCommentStore } from './comment-store.js';
import { createCommentDelivery } from './comment-delivery.js';
import { createPtyIdentityCheck, inForeground } from './pty-foreground.js';
import {
  answerKeys,
  answerRoute,
  bubbleClickTarget,
  pickWorkspaceSession,
  replyRoute,
  workspaceFocusOverride,
} from './bubble-routing.js';
import { generateManagerMessage, humanizeNotification, isPermissionAsk } from './manager-voice.js';
import { digestMessage } from './message-digest.js';
import { askManager, findMentionedSession } from './manager-chat.js';
import { fallbackMessage } from './manager-voice.js';
import { loadConfig, saveConfig } from './config-store.js';
import { TokenBudget } from './token-budget.js';
import { terminal, tts } from './platform.js';
import { VOICES, speechLang } from './sherpa-installer.js';
import { THEMES, PALETTES, backgroundFor } from './themes.js';
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
import { actionMenuAnchor, detectTrayHost, deviceChoice, trayMenuTemplate } from './tray.js';
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
  rulesDir,
  guardDir,
  globalRulesFile,
  PROJECT_RULES_FILE,
} from './paths.js';
import {
  updateDonePhrase,
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
import { readClaudeSettingsFile, readInboundPolicy, setInboundPolicy } from './claude-settings.js';
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

// Launched from inside a Claude Code chat (npm start there): drop that
// session's identity before anything is spawned — tabs and the internal
// `claude -p` runs would otherwise pass for its children (#151).
withoutClaudeSession(process.env);

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
      const english = spokenLang() === 'en';
      speakAsManager(
        result.active
          ? english
            ? 'I installed the GNOME bridge! Now I take you straight to your chat tab.'
            : 'Instalei a ponte do GNOME! Agora eu te levo direto pra aba do teu chat.'
          : english
            ? 'I installed the GNOME bridge! Log out and back in so I can reach your terminal.'
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
    // Already looking at it in the workspace? Then no bark (#96).
    focused:
      workspaceFocusOverride({
        windowFocused: Boolean(workspaceWindow?.isFocused()),
        selectedSessionId: workspaceSelectedSession,
        sessionId: session.id,
      }) ?? (await sessionFocused(session)),
    lastAnnouncement: lastAnnouncements.get(session.id) ?? null,
    announceWhenUnknown: managerConfig.announceWhenFocusUnknown,
    now: Date.now(),
  });
  if (decision.announce) {
    lastAnnouncements.set(session.id, { text, at: Date.now() });
    lastNoticeSessionId = session.id;
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

// Every edit the AI makes, per session and task — the workspace's live diff
// reads from here. Fed by the edit-tool hooks, never by the registry.
const editTracker = new EditTracker();
// Workspace state, declared up here because sendState (and with it
// pushWorkspaceState) can run before the workspace block below is evaluated.
let workspaceWindow = null;
let appQuitting = false;
const worktreeCache = new Map(); // project root → Worktree[]
const repoRootCache = new Map(); // session cwd → repo root | null
let workspacePushTimer = null;
let lastNoticeSessionId = null; // the session the bubble opens the workspace on
let workspaceSelectedSession = null; // what the workspace window shows (for notices)
const answering = new Set(); // sessions with a pty answer in flight
let workspaceRechecked = new Set(); // unplaced cwds whose repo was already re-listed
let ptyHost = null; // created on the first terminal open
const editPipeline = createEditPipeline({
  tracker: editTracker,
  readFile: (file) => fs.promises.readFile(file, 'utf8').catch(() => null),
  readIndexVersion,
  readReason: readEditReason,
});

const registry = new SessionRegistry({
  folderAliasFor: (cwd) => managerConfig.folderAliases[cwd] ?? null,
});
let managerConfig = loadConfig(configFile);
tts.setAudioOutput(managerConfig.audioOutput);

// Voice mode state (#161), declared up here: speakAsManager and sendState
// read it, and they run long before the voice section below.
const voiceSherpaDir = path.join(configDir, 'sherpa');
let voiceListener = null;
let voiceArbiter = null;
let voiceSession = null;
let micWindow = null;
let micDevices = []; // what the mic window found, for the settings picker
let chromiumOutputs = []; // the outputs as Chromium names them, for the bubble chimes
let voiceState = 'off';
let voiceDownload = null; // { percent } | { error } while the models come down
let voiceRestarts = 0;
let meetingTimer = null;

const rulesStore = createRulesStore({
  dir: rulesDir,
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  writeFile: (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  },
  rename: (from, to) => fs.renameSync(from, to),
});
// sendState and the halo are hoisted functions: safe to call from here on.
const guardAsks = createGuardAsks({
  onChange: () => {
    sendState();
    updateNotificationHalo();
    if (guardAsks.pending().length === 0) voiceSession?.onGuardAnswered();
  },
  // An equal ask answered along with the one the user saw.
  onReleased: (request, choice) => recordGuardOutcome({ ...request, summary: guardSummary(request) }, GUARD_OUTCOMES[choice]),
  // The announced ask left without settling its twin: announce the twin.
  onPromote: (ask) => announceGuardAsk(ask),
});

// Guard state read by guardStatus(), which sendState() calls: declared here,
// before anything can send state, instead of next to the guard code at the
// end of the file (a let read before its line throws).
let guardOffline = false;
let guardInstalled = false;
let rulesUnreadable = false;

function recordGuardOutcome(request, outcome) {
  try {
    rulesStore.addHistory({
      at: Date.now(),
      sessionId: request.sessionId ?? null,
      cwd: request.cwd ?? null,
      ruleSource: request.ruleSource ?? '',
      summary: request.summary ?? '',
      outcome,
    });
  } catch (error) {
    log(`guard history failed: ${error}`);
  }
}

// An action with no way back, in the Maestro: the voice offers a review first (#162).
function reviewerHint(ask) {
  if (!maestroOn() || !ask.irreversible) return '';
  const musician = maestroOrchestra.find((item) => item.sessionId === ask.sessionId);
  if (!musician) return '';
  const name = musician.number ?? musician.name;
  return spokenLang() === 'en'
    ? ` No way back: say "chama um avaliador pra ${name}" for a review first.`
    : ` Isso não tem volta: se quiser uma revisão antes, diga "chama um avaliador pra ${name}".`;
}

function onGuardMessage(message, reply) {
  if (message.type === 'guard-event') {
    recordGuardOutcome(message, message.outcome ?? 'barrado');
    return;
  }
  const result = guardAsks.add(message, reply);
  if (result.answered) {
    recordGuardOutcome({ ...message, summary: guardSummary(message) }, 'liberado (sessão)');
    return;
  }
  // The same question already waiting (parallel calls): its answer settles
  // this one too, and saying it twice is noise.
  if (result.duplicate) return;
  const ask = guardAsks.pending().find((candidate) => candidate.id === result.id);
  if (ask) announceGuardAsk(ask);
}

function announceGuardAsk(ask) {
  // The balloon announces; the choices live in the panel and the workspace.
  // In voice mode the session speaks it (priority 2) and takes the answer.
  if (voiceSession) voiceSession.onGuardAsk({ speech: `${guardSpeech(ask, spokenLang())}${reviewerHint(ask)}` });
  sendToRenderer('tooltip', {
    projectName: path.basename(ask.cwd ?? '') || 'Claude',
    text: ask.summary,
    kind: 'guard',
    sessionId: null,
    speech: voiceSession ? null : guardSpeech(ask, spokenLang()),
  });
  showTooltip();
}

function guardSummary(message) {
  return message.tool === 'Bash' ? String(message.input?.command ?? '').slice(0, 200) : message.tool;
}

const GUARD_OUTCOMES = { liberar: 'liberado', 'liberar-sessao': 'liberado nesta sessão', barrar: 'barrado' };
ipcMain.handle('guard:answer', (_event, { id, choice } = {}) => {
  if (!isGuardChoice(choice) || !Object.hasOwn(GUARD_OUTCOMES, choice)) return false;
  const ask = guardAsks.pending().find((candidate) => candidate.id === id);
  const request = guardAsks.answer(id, choice);
  if (request) recordGuardOutcome({ ...request, summary: ask?.summary ?? guardSummary(request) }, GUARD_OUTCOMES[choice]);
  return Boolean(request);
});
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
    guardAsks: guardAsks.pending(),
    guard: guardStatus(),
    voice: voiceStatus(),
    unread: registry.unreadCount(),
    update: updateStatus,
    hint: lastHint,
    voiceDownloading: tts.downloadingVoice(),
    maestroEnabled: maestroOn(),
    // The bubble speaks the alert lines: it must hear about a voice change.
    voiceLang: speechLang(managerConfig.voice),
    // ...and plays the chimes: on the output pinned in the tray menu.
    audioSinkId: chromiumSinkId(chromiumOutputs, managerConfig.audioOutput),
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
  pushWorkspaceState();
}

// --- Maestro (#159): the stage in the workspace ------------------------------
// The orchestra is rebuilt on every workspace push; the focus is not saved.
let maestroOrchestra = [];
let maestroFocusId = null;
const maestroNarrators = new Map(); // sessionId → narrator, for the consequences strip
const maestroOrder = createPendingOrder();
maestroOrder.on('show', (order) => {
  workspaceWindow?.send('maestro:order', order);
  // Listening already: "cancela" needs no "Vizor" in front (review C1).
  if (voiceState === 'sleeping') voiceListener?.wake();
});
maestroOrder.on('clear', () => workspaceWindow?.send('maestro:order', null));

const maestroOn = () => Boolean(managerConfig.maestroEnabled);

// The balloon shows what is said, spoken or not (the voice may be off).
function maestroSay(source, text) {
  if (!maestroOn() || !text) return;
  workspaceWindow?.send('maestro:say', { source: source ?? 'manager', text: String(text) });
}

// The consequences strip has its own narrator: it runs with the voice off too.
function maestroNarrate(event) {
  if (!maestroOn() || !event?.session_id) return;
  if (!maestroOrchestra.some((musician) => musician.sessionId === event.session_id)) return;
  let narrator = maestroNarrators.get(event.session_id);
  if (!narrator) maestroNarrators.set(event.session_id, (narrator = createNarrator()));
  const line = narrator.narrate(event);
  if (line) workspaceWindow?.send('maestro:narration', { sessionId: event.session_id, text: line.text });
}

// The graph of each músico's checkout (#159, part 2): built off the main
// thread when the Maestro turns on, refreshed after a músico's edit.
let graphParser = null;
const graphIndexers = new Map(); // checkout root → indexer
const graphRefreshTimers = new Map();
const maestroPlans = new Map(); // sessionId → the plan its "Vizor-plano:" line declared
const taskTitles = new Map(); // ptyId → '#169 Menu de ação…', the tab of a chat opened for a task
// The checklist each chat keeps in .vizor/plano.md, shown live (the core flow).
const workPlans = createPlanTracker({
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  knownCwd: (cwd) => workspaceProjects().includes(cwd) || [...worktreeCache.values()].some((trees) => (trees ?? []).some((tree) => tree.path === cwd)),
});
const touchCache = new Map(); // memo of touchedFunctions, cleared when a graph changes

function graphFor(root) {
  if (!root) return null;
  let indexer = graphIndexers.get(root);
  if (!indexer) {
    graphParser ??= createWorkerParser();
    const parser = graphParser; // this indexer's own: a later Maestro gets a new one
    indexer = createGraphIndexer({
      root,
      listFiles: async () => (await runText('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root })).split('\n').filter(Boolean),
      statFile: (relPath) => fs.promises.stat(path.join(root, relPath)),
      readFile: (relPath) => fs.promises.readFile(path.join(root, relPath), 'utf8'),
      parse: (source, relPath) => parser.parse(source, relPath),
    });
    indexer.on('graph', (graph) => {
      if (graphIndexers.get(root) !== indexer) return; // dropped while it was parsing
      touchCache.clear();
      notifyReview(root); // the Impacto tab polls again: the indexer reports no progress
      pushWorkspaceState();
    });
    graphIndexers.set(root, indexer);
    indexer.refresh().catch((error) => log(`graph failed for ${root}: ${error}`));
  }
  return indexer;
}

// The graphs outlive the Maestro (the review screen reads them too): they are
// dropped only after the workspace window stayed hidden or minimized this long,
// and never while the Maestro is on (it reads them with the window hidden).
const GRAPH_DISCARD_MS = 10 * 60 * 1000;
let graphDiscardTimer = null;
function armGraphDiscard() {
  clearTimeout(graphDiscardTimer);
  graphDiscardTimer = setTimeout(() => {
    graphDiscardTimer = null;
    if (maestroOn()) return;
    for (const timer of graphRefreshTimers.values()) clearTimeout(timer);
    graphRefreshTimers.clear();
    graphIndexers.clear();
    graphParser?.close();
    graphParser = null;
  }, GRAPH_DISCARD_MS);
}
function disarmGraphDiscard() {
  clearTimeout(graphDiscardTimer);
  graphDiscardTimer = null;
}

// An edit by any session whose worktree has a graph: that file is parsed
// again, at most every 0.5 s per checkout.
function graphTouched(event) {
  const root = sessionWorktree(event?.session_id);
  const filePath = event?.tool_input?.file_path ?? event?.tool_input?.notebook_path;
  const indexer = root && graphIndexers.get(root);
  if (!indexer || !filePath) return;
  indexer.touch(path.relative(root, filePath).split(path.sep).join('/'));
  clearTimeout(graphRefreshTimers.get(root));
  graphRefreshTimers.set(
    root,
    setTimeout(() => indexer.refreshTouched().catch((error) => log(`graph refresh failed: ${error}`)), 500),
  );
}

// What each músico touched (its task's files against the graph) and plans.
function maestroImpacts() {
  const impacts = [];
  for (const musician of maestroOrchestra) {
    const graph = musician.root ? graphIndexers.get(musician.root)?.graph() : null;
    if (!graph || graph.unavailable) continue;
    const touched = [];
    const touchedModules = [];
    for (const [filePath, file] of editTracker.currentTask(musician.sessionId)?.files ?? []) {
      const relPath = path.relative(musician.root, filePath).split(path.sep).join('/');
      touchedModules.push(relPath);
      const key = `${musician.sessionId}|${relPath}|${file.start?.length ?? 'new'}|${file.current?.length ?? 0}`;
      if (!touchCache.has(key)) touchCache.set(key, touchedFunctions(graph, relPath, file.start, file.current));
      touched.push(...touchCache.get(key));
    }
    const impact = impactOf(graph, { touched, touchedModules, planned: maestroPlans.get(musician.sessionId) ?? [] });
    impacts.push({ sessionId: musician.sessionId, root: musician.root, color: musician.color, ...impact });
  }
  return impacts;
}

// --- the conducting gerente (#162): your orders, kept until a músico's turn ends
const maestroConductor = createConductor({ lang: () => spokenLang() });
const turnTests = new Map(); // sessionId → the last test verdict of its current turn
const reviewerOffered = new Set(); // músicos already offered a reviewer

function runConductor(actions) {
  for (const action of actions) {
    if (action.type === 'prompt') {
      turnTests.delete(action.sessionId); // a new turn starts with this prompt
      // Not safe to type yet (a question on screen, just settling, the user
      // typing in that tab): tried again; never arrived, the order waits and
      // you hear it (review C1, I1).
      const userTyping = () => Date.now() - (userTypedAt.get(ptyOfSession(action.sessionId)) ?? 0) < USER_TYPING_MS;
      const deliver = (tries) =>
        (userTyping() ? Promise.resolve('hold') : voiceDeliverPrompt(action.sessionId, action.text))
          .then((outcome) => {
            if (outcome === 'hold' && tries < 5) return setTimeout(() => deliver(tries + 1), 2000);
            if (outcome !== 'sent') log(`conductor prompt to ${action.sessionId.slice(0, 8)}: ${outcome}`);
            return runConductor(maestroConductor.delivered(action.sessionId, outcome === 'sent'));
          })
          .catch((error) => {
            log(`conductor prompt failed: ${error}`);
            runConductor(maestroConductor.delivered(action.sessionId, false));
          });
      deliver(0);
    } else if (voiceSession) voiceSession.onConductorAction(action);
    else speakAsManager(action.text);
  }
  pushWorkspaceState();
}

// A músico's turn ended: the gerente's order moves on, and a big or risky
// change offers a reviewer (once per músico).
function maestroTurnEnded(musician) {
  runConductor(maestroConductor.turnEnded(musician.sessionId, { tests: turnTests.get(musician.sessionId) ?? null }));
  turnTests.delete(musician.sessionId);
  // Once per task (or per chat without one), and only if the voice could ask.
  const offerKey = musician.number !== null ? `task:${musician.root}:${musician.number}` : musician.sessionId;
  if (!voiceSession || reviewerOffered.has(offerKey)) return;
  const graph = musician.root ? graphIndexers.get(musician.root)?.graph() : null;
  const impact = maestroImpacts().find((item) => item.sessionId === musician.sessionId);
  if (!graph || graph.unavailable || !impact) return;
  const offer = shouldSuggest(impact, criticalOf(graph), new Set());
  if (offer && voiceSession.onSuggestReviewer({ musician, ...offer })) reviewerOffered.add(offerKey);
}

// --- the backstage (#142): sub-agents, background logs, ports, per músico ---
// Claude Code keeps background logs under <tmp>/claude-<uid> (TMPDIR honoured).
const backstage = createBackstage({ tmpRoot: path.join(os.tmpdir(), `claude-${process.getuid?.() ?? ''}`) });
const backstageLogs = new Map(); // output file → { lines, gone, idleSeconds }
const backstagePorts = new Map(); // sessionId → [{ port, process }]
let backstageTimers = null;

async function refreshBackstageLogs() {
  let changed = false;
  for (const musician of maestroOrchestra)
    for (const item of backstage.backgroundOf(musician.sessionId)) {
      const tail = await readTail(item.outputFile);
      const before = JSON.stringify(backstageLogs.get(item.outputFile));
      // Quiet time in whole minutes: the stage redraws when it moves a minute, not every 2 s.
      const idleSeconds = tail.mtimeMs ? Math.floor((Date.now() - tail.mtimeMs) / 60000) * 60 : 0;
      backstageLogs.set(item.outputFile, { lines: tail.lines, gone: tail.gone, idleSeconds });
      changed ||= before !== JSON.stringify(backstageLogs.get(item.outputFile));
    }
  if (changed) pushWorkspaceState();
}

// Who is whose parent, from /proc/<pid>/stat ("pid (comm) state ppid …").
async function readParents() {
  const parents = new Map();
  for (const name of await fs.promises.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await fs.promises.readFile(`/proc/${name}/stat`, 'utf8').catch(() => null);
    if (stat) parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
  }
  return parents;
}

async function refreshBackstagePorts() {
  if (!maestroOrchestra.length) return;
  const listeners = parseListeners(await runText('ss', ['-ltnpH']).catch(() => ''));
  const parents = listeners.length ? await readParents() : new Map();
  let changed = false;
  for (const musician of maestroOrchestra) {
    // No listener anywhere: no músico has a port, nothing to look up.
    const pid = listeners.length ? readSessionPid(musician.sessionId) : null;
    const ports = pid && listeners.length ? portsFor(listeners, descendantsOf(pid, parents)) : [];
    changed ||= JSON.stringify(ports) !== JSON.stringify(backstagePorts.get(musician.sessionId) ?? []);
    backstagePorts.set(musician.sessionId, ports);
  }
  if (changed) pushWorkspaceState();
}

// Logs every 2 s and ports every 5 s, only while the Maestro is on.
function syncBackstageTimers() {
  if (maestroOn() && !backstageTimers) {
    backstageTimers = [
      setInterval(() => refreshBackstageLogs().catch((error) => log(`backstage logs failed: ${error}`)), 2000),
      setInterval(() => refreshBackstagePorts().catch((error) => log(`backstage ports failed: ${error}`)), 5000),
    ];
  } else if (!maestroOn() && backstageTimers) {
    backstageTimers.forEach(clearInterval);
    backstageTimers = null;
  }
}

function backstageOf(sessionId) {
  return {
    subagents: backstage.subagentsOf(sessionId),
    background: backstage.backgroundOf(sessionId).map((item) => ({
      id: item.id,
      command: item.command,
      ...(backstageLogs.get(item.outputFile) ?? { lines: [], gone: false, idleSeconds: 0 }),
    })),
    ports: backstagePorts.get(sessionId) ?? [],
  };
}

function maestroFocus(sessionId) {
  maestroFocusId = sessionId;
  workspaceWindow?.focusSession(sessionId);
  pushWorkspaceState();
}

function maestroInterrupt(ptyId) {
  if (!ptyHost?.list().some((terminal) => terminal.id === ptyId && terminal.alive)) return false;
  ptyHost.write(ptyId, '\x1b'); // Esc: Claude Code stops the turn, the session lives on
  return true;
}

ipcMain.on('maestro:set', (_event, on) => applyConfig({ maestroEnabled: Boolean(on) }));

// A prompt for a chat waits for its turn to end, like the voice's, up to a minute.
async function deliverWhenFree(sessionId, text, { tries = 30, everyMs = 2000 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const result = await voiceDeliverPrompt(sessionId, text);
    if (result !== 'hold') return result;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return 'timeout';
}

// Picking an issue by keyboard: its chat if it has one (the newest of several),
// otherwise a new one asked for the plan first.
async function startIssue(number) {
  const root = voiceRoot();
  if (!root) return { error: 'Abra um projeto no workspace primeiro.' };
  const found = await voiceResolveTask(number, { byTitle: false });
  log(`issue ${number}: ${found.sessionId ? `its chat ${found.sessionId}` : `new chat in ${found.cwd ?? root}`}`);
  const existing = found.sessionId ? found : null;
  if (existing?.sessionId) {
    await voiceOpenOrFocus({ sessionId: existing.sessionId, cwd: existing.cwd });
    taskLinks.link(root, number, existing.sessionId);
    return { sessionId: existing.sessionId };
  }
  const opened = await voiceOpenNew({ cwd: found.cwd ?? root, prompt: startIssuePrompt(number), task: number });
  if (!opened.sessionId) return { error: 'Não consegui abrir o chat da issue.' };
  taskLinks.link(root, number, opened.sessionId);
  workspaceWindow?.focusSession(opened.sessionId); // its plan card comes up in front
  return { sessionId: opened.sessionId };
}

// What the Ctrl+K bar lists from GitHub: open issues and PRs, read by gh.
ipcMain.handle('workspace:catalog', async (event) => {
  if (!fromWorkspace(event)) return { issues: [], prs: [], error: true };
  const root = voiceRoot();
  if (catalogStale({ resultsRoot: lastGhResultsRoot, root, at: lastGhDigestAt, now: Date.now(), maxAge: GH_DIGEST_MAX_AGE_MS })) await voiceGhDigest();
  return catalogFrom({ results: lastGhResults, resultsRoot: lastGhResultsRoot, root });
});

// The action the bar picked; focus is the renderer's own.
ipcMain.handle('workspace:command', async (event, action = {}) => {
  if (!fromWorkspace(event)) return { error: 'Ação desconhecida.' };
  try {
    if (action.type === 'pick-issue' && Number.isInteger(action.number)) {
      log(`command: pick issue ${action.number}`);
      const started = await startIssue(action.number);
      log(`command: issue ${action.number} → ${started.error ?? `chat ${started.sessionId}`}`);
      return started;
    }
    if (action.type === 'review-pr' && Number.isInteger(action.number)) {
      const root = voiceRoot();
      if (!root) return { error: 'Abra um projeto no workspace primeiro.' };
      const opened = await voiceOpenNew({ cwd: root, prompt: reviewPrPrompt(action.number) });
      if (!opened.sessionId) return { error: 'Não consegui abrir o chat do avaliador.' };
      taskLinks.link(root, action.number, opened.sessionId);
      return { sessionId: opened.sessionId };
    }
    if (action.type === 'interrupt' && typeof action.sessionId === 'string') {
      const ptyId = ptyOfSession(action.sessionId);
      return ptyId && maestroInterrupt(ptyId) ? {} : { error: 'Esse chat não está numa aba do Vizor.' };
    }
    if (action.type === 'maestro') {
      applyConfig({ maestroEnabled: Boolean(action.on) });
      return {};
    }
    return { error: 'Ação desconhecida.' };
  } catch (error) {
    log(`command failed: ${error?.stack ?? error}`);
    return { error: 'Deu erro, veja o log.' };
  }
});

// The plan card's buttons: the ok, and the PR once every step is done.
const planActions = createPlanActions({
  planOf: (sessionId) => workPlans.planOf(sessionId),
  approve: (sessionId) => {
    workPlans.approve(sessionId);
    pushWorkspaceState();
  },
  deliver: (sessionId, text) => deliverWhenFree(sessionId, text),
});
const planAction = (sessionId, action) => planActions.run(sessionId, action);
ipcMain.handle('workspace:plan', (event, { sessionId, action } = {}) => (fromWorkspace(event) ? planAction(sessionId, action) : 'failed'));
ipcMain.on('maestro:focus', (_event, sessionId) => {
  if (typeof sessionId === 'string' && maestroOrchestra.some((musician) => musician.sessionId === sessionId)) maestroFocus(sessionId);
});

// What the Vizor says follows the chosen voice's language (#161).
function spokenLang() {
  return speechLang(managerConfig.voice);
}

function speakAsManager(text) {
  if (!voiceArbiter) maestroSay('manager', text);
  if (!managerConfig.ttsEnabled) return;
  // In voice mode one arbiter decides who speaks when (#161).
  if (voiceArbiter) {
    voiceArbiter.say({ text, priority: 4, source: 'manager' });
    return;
  }
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
  const phrase = updateAnnouncement(previous, status, managerConfig.autoUpdate, spokenLang());
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
      liveTerminals: ptyHost?.aliveCount() ?? 0,
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
    // Merge: the workspace window keeps its bounds in this same file.
    fs.writeFileSync(stateFile, JSON.stringify({ ...loadPersistedState(), bubble: bubbleAnchor }));
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

// A plain bubble click (#96): on Linux the workspace, on the session of the
// last notice; elsewhere the panel, as always. Right-click keeps the panel.
function activateBubble() {
  if (bubbleClickTarget({ workspaceAvailable: Boolean(workspaceWindow) }) === 'panel') {
    sendToRenderer('ui:click'); // the bubble renderer toggles the panel, as before
    return;
  }
  if (overlayMode === 'panel') hideOverlay();
  const sessionId = pickWorkspaceSession({ lastNoticeSessionId, sessions: registry.list() });
  if (sessionId) workspaceWindow.focusSession(sessionId);
  else workspaceWindow.show();
}
ipcMain.on('bubble:activate', () => activateBubble());

// The workspace's "vzr" label opens the tray's menu (#169), for whoever has no
// tray to reach it from.
ipcMain.on('workspace:action-menu', (event, rect) => {
  if (!fromWorkspace(event)) return;
  const window = workspaceWindow.window();
  if (!window || window.isDestroyed()) return;
  buildActionMenu({ canHide: Boolean(tray) }).popup({ window, ...actionMenuAnchor(rect) });
});

// The balloon of a session born in the Vizor opens its workspace tab, like
// its panel card (spec §9.1, #144); any other balloon opens the panel.
ipcMain.on('tooltip:click', (_event, sessionId) => {
  const session = linkedSession(sessionId);
  if (session?.term?.VIZOR_PTY_ID && workspaceWindow) {
    hideOverlay();
    workspaceWindow.focusSession(session.id);
    return;
  }
  openPanel();
});
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
  const state = guardAsks.pending().length ? 'permission' : haloState(registry.list());
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
    // Electron sees a press, never a release: press to talk, silence closes.
    voiceTalk: () => voiceListener?.wake(),
    voiceMute: () => {
      if (!voiceListener) return;
      const muting = voiceState !== 'muted';
      voiceListener.mute(muting);
      // Muted means the microphone is off, OS indicator included.
      micWindow?.webContents.send('mic:control', muting ? 'stop' : 'start');
      const lines = spokenLang() === 'en' ? ['Mic muted.', 'Mic back on.'] : ['Microfone mudo.', 'Microfone de volta.'];
      voiceArbiter?.say({ text: muting ? lines[0] : lines[1], priority: 1 });
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

// The tray menu and the workspace's "vzr" menu (#169) are this one menu: same items,
// same actions, built fresh so the checked devices are current.
function buildActionMenu({ canHide = true } = {}) {
  const actions = {
    panel: () => {
      showBubble();
      openPanel();
    },
    settings: () => openSettingsWindow(),
    toggle: () => (bubbleVisible() ? hideToTray() : showBubble()),
    find: findBubble,
    quit: () => requestQuit().catch((error) => log(`quit failed: ${error}`)),
    workspace: () => workspaceWindow?.show(),
    rules: () => openRulesWindow(),
  };
  const pick = (id) => {
    const choice = deviceChoice(id);
    if (!choice) return;
    const devices = choice.kind === 'mic' ? micDevices : audioOutputs;
    const device = choice.index === 'default' ? null : devices[choice.index] ?? null;
    applyConfig(choice.kind === 'mic' ? { voiceMic: device } : { audioOutput: device });
  };
  const wire = (item) => {
    if (item.submenu) return { ...item, submenu: item.submenu.map(wire) };
    if (!item.id) return item;
    return { ...item, click: actions[item.id] ?? (() => pick(item.id)) };
  };
  const audio =
    process.platform === 'linux'
      ? { mics: micDevices, mic: managerConfig.voiceMic ?? null, outputs: audioOutputs, output: managerConfig.audioOutput ?? null }
      : null;
  const template = trayMenuTemplate({ bubbleVisible: bubbleVisible(), workspace: Boolean(workspaceWindow), audio, canHide });
  return Menu.buildFromTemplate(template.map(wire));
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildActionMenu());
}

// The outputs for the tray menu, from PipeWire; re-read every few seconds so
// a headset plugged in shows up (Linux only, where the voice runs).
let audioOutputs = [];
async function refreshAudioOutputs() {
  try {
    const next = listSinks(parsePwDump(await runText('pw-dump', [])));
    if (JSON.stringify(next) === JSON.stringify(audioOutputs)) return;
    audioOutputs = next;
    log(`audio outputs: ${next.map((sink) => sink.label).join(' | ') || 'none'}`);
    refreshTrayMenu();
  } catch {
    // no pw-dump: the menu keeps the system default only
  }
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

ipcMain.on('app:quit', () =>
  tray ? hideToTray() : requestQuit().catch((error) => log(`quit failed: ${error}`)),
);


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
  const playing = maestroOrchestra.find((musician) => musician.sessionId === session.id);
  if (playing) {
    maestroSay(session.id, snapshot.lastAssistantMessage);
    // The plan it declared lights up on the graph, dashed (#159).
    const plan = playing.root ? parsePlan(snapshot.lastAssistantMessage, playing.root) : [];
    if (plan.length) maestroPlans.set(session.id, plan);
    if (maestroOn()) maestroTurnEnded(playing);
  }
  // The chat bound to the voice answers in its own words, not the gerente's
  // alert — and no tokens go to the alert (#161).
  const bound = voiceSession?.target();
  if (bound?.kind === 'chat' && bound.sessionId === session.id) {
    await voiceSession.onSessionStop({ id: session.id, lastMessage: snapshot.lastAssistantMessage });
    return;
  }
  let voice;
  // Mid-conversation, another chat finishing is a short fixed line: no
  // Haiku tokens for an alert that only interrupts (#161).
  if (isEconomyMode() || voiceArbiter?.inConversation()) {
    voice = fallbackMessage(displayNameOf(session), Math.random, spokenLang());
  } else {
    voice = await generateManagerMessage({
      projectName: displayNameOf(session),
      lastAssistantMessage: snapshot.lastAssistantMessage,
      lang: spokenLang(),
    });
    tokenBudget.add(voice.tokensUsed);
  }
  registry.setManagerMessage(session.id, voice);
  if (await allowAnnouncement(session, 'done', voice.message)) {
    sendToRenderer('tooltip', {
      projectName: displayNameOf(session),
      text: voice.message,
      kind: 'done',
      sessionId: session.id,
    });
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
      sessionId: session.id,
    });
    showTooltip();
  }
}

// --- workspace window (Linux only in v1) -----------------------------------
// Nothing here runs for someone who never opens it: the window, the git
// worktree lookups and the project auto-add all start at the first open.
workspaceWindow = workspaceAvailable(process.platform)
  ? createWorkspaceWindowManager({
      BrowserWindow,
      preloadPath: path.join(rendererDir, 'workspace-preload.cjs'),
      htmlPath: path.join(rendererDir, 'workspace.html'),
      loadBounds: () => {
        const saved = loadPersistedState().workspace ?? null;
        return boundsVisible(saved, screen.getAllDisplays()) ? saved : null;
      },
      saveBounds: (bounds) => {
        try {
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(stateFile, JSON.stringify({ ...loadPersistedState(), workspace: bounds }));
        } catch (error) {
          log(`workspace bounds save failed: ${error}`);
        }
      },
      onFocus: () => onWorkspaceFocus(),
      onShow: () => {
        refreshWorkspace().catch((error) => log(`workspace refresh failed: ${error}`));
      },
      // A (re)loaded page starts from the replay, and a dead one acks
      // nothing: either way, what was in flight will never be acked (#113).
      onLoad: () => ptyHost?.resetFlow(),
      onGone: () => {
        log('workspace renderer gone — terminals resumed, reloading on next open');
        ptyHost?.resetFlow();
      },
      isQuitting: () => appQuitting,
      // First frame in the palette's own colour (#108).
      background: () => {
        try {
          return backgroundFor(managerConfig, fs.readFileSync(path.join(rendererDir, 'tokens.css'), 'utf8'));
        } catch {
          return '#0d1117';
        }
      },
    })
  : null;

function workspaceProjects() {
  return managerConfig.workspaceProjects ?? [];
}

function workspaceDismissed() {
  return managerConfig.workspaceDismissed ?? [];
}

function saveWorkspaceProjects(projects, dismissed = workspaceDismissed()) {
  managerConfig = { ...managerConfig, workspaceProjects: projects, workspaceDismissed: dismissed };
  try {
    saveConfig(configFile, managerConfig);
  } catch (error) {
    log(`workspace projects save failed: ${error}`);
  }
}

// Outside sessions bring their repo in by themselves (spec §9.1): a session
// in a repo not listed yet adds it. Non-git folders only come in by hand.
async function autoAddProjects() {
  let added = false;
  for (const session of registry.list()) {
    if (!session.cwd || repoRootCache.has(session.cwd)) continue;
    const root = await repoRootOf(session.cwd);
    repoRootCache.set(session.cwd, root);
    if (shouldAutoAdd(root, workspaceProjects(), workspaceDismissed(), app.getPath('home'))) {
      saveWorkspaceProjects(addProject(workspaceProjects(), root));
      added = true;
    }
  }
  return added;
}

async function refreshWorkspace() {
  if (!workspaceWindow) return;
  await autoAddProjects();
  await Promise.all(
    workspaceProjects().map(async (root) => worktreeCache.set(root, await listWorktrees(root))),
  );
  pushWorkspaceStateNow();
}

// Project avatars (root -> data: URI | null). Resolved off the push path: the
// state goes out at once (monogram), the avatar joins when it is read/downloaded.
const avatarService = createAvatarService({ dir: path.join(configDir, 'avatars'), fetchImage: fetchAvatarImage, fsp: fs.promises });
const projectAvatars = new Map();
function resolveProjectAvatar(root) {
  if (projectAvatars.has(root)) return;
  projectAvatars.set(root, null);
  (async () => {
    const owner = avatarOwnerOf(await runText('git', ['remote', 'get-url', 'origin'], { cwd: root }).catch(() => ''));
    if (!owner) return;
    const cached = await avatarService.load(owner);
    if (cached.uri) {
      projectAvatars.set(root, cached.uri);
      pushWorkspaceState();
    }
    if (cached.fresh) return;
    const uri = await avatarService.refresh(owner);
    if (uri) {
      projectAvatars.set(root, uri);
      pushWorkspaceState();
    }
  })().catch((error) => log(`avatar: ${root}: ${error}`));
}

function pushWorkspaceStateNow() {
  if (!workspaceWindow?.isReady()) return;
  const projects = workspaceProjects().map((root) => ({
    root,
    worktrees: worktreeCache.get(root) ?? [],
  }));
  for (const { root } of projects) resolveProjectAvatar(root);
  const tree = buildWorkspaceTree({
    projects,
    sessions: linkedSessions(listWithDisplayNames()),
    taskOf: (sessionId) => editTracker.currentTask(sessionId),
  });
  maestroOrchestra = buildOrchestra(tree, (sessionId, root) => (root ? taskLinks.numberOf(root, sessionId) : null));
  maestroFocusId = nextFocus(maestroOrchestra, maestroFocusId);
  for (const sessionId of workPlans.sessions()) if (!registry.sessions.has(sessionId)) workPlans.forget(sessionId);
  if (maestroOn()) for (const musician of maestroOrchestra) graphFor(musician.root);
  syncBackstageTimers();
  // Sessions that are no músico (any more) leave the backstage.
  if (maestroOn())
    for (const sessionId of backstage.sessions())
      if (!maestroOrchestra.some((musician) => musician.sessionId === sessionId)) {
        for (const item of backstage.backgroundOf(sessionId)) backstageLogs.delete(item.outputFile);
        backstage.forget(sessionId);
        backstagePorts.delete(sessionId);
      }
  // A músico gone with an order pending: the gerente says it could not do it.
  for (const { sessionId } of maestroConductor.list())
    if (!maestroOrchestra.some((musician) => musician.sessionId === sessionId)) queueMicrotask(() => runConductor(maestroConductor.sessionGone(sessionId)));
  for (const sessionId of [...maestroNarrators.keys(), ...maestroPlans.keys()])
    if (!maestroOrchestra.some((musician) => musician.sessionId === sessionId)) {
      maestroNarrators.delete(sessionId);
      maestroPlans.delete(sessionId);
    }
  workspaceWindow.send('workspace:state', {
    tree,
    terminals: (ptyHost?.list() ?? []).map((terminal) => ({ ...terminal, taskTitle: taskTitles.get(terminal.id) ?? null })),
    activeTerminal: activeTerminalId,
    guardAsks: guardAsks.pending(),
    voice: voiceListener ? { state: voiceState, target: voiceStatus().target } : null,
    maestro: {
      on: maestroOn(),
      orchestra: maestroOrchestra,
      focusedId: maestroFocusId,
      impacts: maestroOn() ? maestroImpacts() : [],
      orders: Object.fromEntries(maestroConductor.list().map((order) => [order.sessionId, order.label])),
      backstage: maestroOn() ? Object.fromEntries(maestroOrchestra.map((musician) => [musician.sessionId, backstageOf(musician.sessionId)])) : {},
    },
    plans: Object.fromEntries(workPlans.sessions().map((sessionId) => [sessionId, workPlans.planOf(sessionId)])),
    theme: managerConfig.theme,
    palette: managerConfig.palette,
    avatars: Object.fromEntries(projects.map(({ root }) => [root, projectAvatars.get(root) ?? null])),
  });
  // A session in a known repo that matches no worktree: one was probably
  // just created. Re-list that repo once per cwd (staleRoots), and re-resolve
  // the cwd itself — a removed worktree then simply stops resolving.
  const { roots, rechecked } = staleRoots({
    unplaced: tree.unplaced,
    rootOf: (cwd) => (worktreeCache.has(repoRootCache.get(cwd)) ? repoRootCache.get(cwd) : null),
    rechecked: workspaceRechecked,
  });
  const newlyChecked = [...rechecked].filter((cwd) => !workspaceRechecked.has(cwd));
  workspaceRechecked = rechecked;
  if (roots.length) {
    for (const cwd of newlyChecked) repoRootCache.delete(cwd);
    for (const root of roots) worktreeCache.delete(root);
    refreshWorkspace().catch((error) => log(`workspace refresh failed: ${error}`));
  }
}

function pushWorkspaceState() {
  if (!workspaceWindow?.isOpen() || workspacePushTimer) return;
  workspacePushTimer = setTimeout(() => {
    workspacePushTimer = null;
    autoAddProjects()
      .then((added) => (added ? refreshWorkspace() : pushWorkspaceStateNow()))
      .catch((error) => log(`workspace push failed: ${error}`));
  }, 150);
}

editTracker.on('change', () => pushWorkspaceState());

ipcMain.handle('workspace:add-project', async () => {
  const options = { title: 'Abrir projeto', properties: ['openDirectory'] };
  // Parented to the workspace so it never opens behind it (#107).
  const parent = workspaceWindow?.window();
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
  if (result.canceled || !result.filePaths[0]) return;
  const dir = result.filePaths[0];
  const root = (await repoRootOf(dir)) ?? dir;
  // Adding by hand undoes an earlier "Tirar da lista".
  saveWorkspaceProjects(
    addProject(workspaceProjects(), root),
    workspaceDismissed().filter((candidate) => candidate !== root),
  );
  await refreshWorkspace();
});

ipcMain.on('workspace:remove-project', (_event, root) => {
  if (typeof root !== 'string') return;
  // Remembered, so auto-add does not bring it straight back.
  saveWorkspaceProjects(removeProject(workspaceProjects(), root), addProject(workspaceDismissed(), root));
  worktreeCache.delete(root);
  pushWorkspaceStateNow();
});

// --- workspace terminals (#92) -------------------------------------------
function ensurePtyHost() {
  if (ptyHost) return { host: ptyHost, error: null };
  const { pty, error } = loadPty();
  if (!pty) return { host: null, error };
  ptyHost = createPtyHost({ spawn: pty.spawn, shell: process.env.SHELL || '/bin/bash' });
  ptyHost.on('data', (payload) => {
    if (workspaceWindow?.isReady()) workspaceWindow.send('pty:data', payload);
    // Nobody to draw it: count it as drawn, or the terminal would pause (#113).
    else ptyHost.ack(payload.id, payload.data.length);
  });
  ptyHost.on('exit', (payload) => {
    if (workspaceWindow?.isReady()) workspaceWindow.send('pty:exit', payload);
  });
  ptyHost.on('change', () => {
    pushWorkspaceStateNow();
    scheduleTabsSave();
    // An auto-update held back by live terminals goes through once the last ends.
    if (ptyHost.aliveCount() === 0) onUpdateStatus(updateStatus);
  });
  return { host: ptyHost, error: null };
}

const fromWorkspace = (event) => Boolean(workspaceWindow?.ownsSender(event.sender));

function isDirectory(dir) {
  try {
    return typeof dir === 'string' && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// New pty id → the chat it resumed, until that chat's first hook event names
// the tab itself (#155).
const resumedChats = new Map();

function linkedSessions(sessions) {
  const ids = ptyHost?.list().map((terminal) => terminal.id) ?? [];
  for (const ptyId of [...resumedChats.keys()]) if (!ids.includes(ptyId)) resumedChats.delete(ptyId);
  return linkTerminals(sessions, ids, resumedChats);
}

// One session with the tab it runs in NOW (#157): a pty id left over from an
// earlier run doesn't count as "in the Vizor", and a chat resumed in a tab is
// reachable there before its first hook event. Every path that types into a
// tab or focuses one goes through this, never the raw registry term.
function linkedSession(sessionId) {
  const session = typeof sessionId === 'string' ? registry.sessions.get(sessionId) : null;
  return session ? linkedSessions([session])[0] : null;
}

// kind: 'shell' | 'claude' | 'resume' (with sessionId) — #154.
function openTerminal({ cwd, kind, sessionId, prompt = null }) {
  const { command, error: invalid } = terminalCommand({ kind, sessionId, prompt });
  if (invalid) return { error: invalid };
  if (!isDirectory(cwd)) return { error: 'pasta não existe' };
  const { host, error } = ensurePtyHost();
  if (!host) {
    log(`pty unavailable: ${error} (${loadPty().detail ?? '-'})`);
    return { error };
  }
  const { id } = host.open({ cwd, command });
  if (kind === 'resume') {
    resumedChats.set(id, sessionId);
    // open() already pushed the state, before this link existed.
    pushWorkspaceStateNow();
    // claude registers itself a moment after it starts.
    for (const delay of [2500, 6000]) setTimeout(adoptResumedChats, delay);
  }
  return { id };
}

ipcMain.handle('pty:open', (event, { cwd, kind = 'claude', sessionId = null } = {}) => {
  if (!fromWorkspace(event)) return { error: 'origem inválida' };
  return openTerminal({ cwd, kind, sessionId });
});

// The chats Claude Code saved for a folder, for "retomar conversa" (#154).
// One already running somewhere (another terminal, a tab here) is marked:
// resuming it twice would put two processes on one history.
ipcMain.handle('workspace:conversations', async (event, cwd) => {
  if (!fromWorkspace(event) || typeof cwd !== 'string') return [];
  const live = readLiveSessionIds();
  // linkedSessions first: it also forgets resumes whose tab is gone.
  const linked = linkedSessions(registry.list()).filter((session) => session.term?.VIZOR_PTY_ID);
  const tabs = new Map([
    ...[...resumedChats].map(([ptyId, sessionId]) => [sessionId, ptyId]),
    ...linked.map((session) => [session.id, session.term.VIZOR_PTY_ID]),
  ]);
  const list = await listConversations(await resolveClaudeProjectDir(cwd));
  return list.map((conversation) => ({
    ...conversation,
    open: Boolean(live?.has(conversation.sessionId)),
    tab: tabs.get(conversation.sessionId) ?? null,
  }));
});

// "Trazer pro Vizor" (#156): an outside chat whose process is gone comes back
// in a tab. Still running somewhere: refused, same reason as above. A closed
// chat is reaped from the list within LIVENESS_INTERVAL_MS, so the usual way
// back is the + menu's "retomar conversa"; this covers the chat still listed.
function outsideStatus(sessionId) {
  const session = linkedSessions(registry.list()).find((candidate) => candidate.id === sessionId);
  if (!session || session.term?.VIZOR_PTY_ID) return { canBring: false, why: null };
  if (!isSessionId(sessionId)) return { canBring: false, why: 'conversa sem id do Claude Code' };
  if (!isDirectory(session.cwd)) return { canBring: false, why: 'a pasta dela não existe mais' };
  const live = readLiveSessionIds();
  if (live === null) return { canBring: false, why: 'não dá pra saber se ela ainda está aberta em outro terminal' };
  if (live.has(sessionId))
    return { canBring: false, why: 'ainda aberta no outro terminal. Feche lá e retome pelo + desta worktree.' };
  return { canBring: true, why: null };
}

ipcMain.handle('workspace:outside-status', (event, sessionId) =>
  fromWorkspace(event) ? outsideStatus(sessionId) : { canBring: false, why: null },
);

ipcMain.handle('workspace:bring', (event, sessionId) => {
  if (!fromWorkspace(event)) return { error: 'origem inválida' };
  const status = outsideStatus(sessionId);
  if (!status.canBring) return { error: status.why ?? 'não dá pra trazer essa conversa' };
  const session = registry.list().find((candidate) => candidate.id === sessionId);
  return openTerminal({ cwd: session.cwd, kind: 'resume', sessionId });
});

// --- tabs across restarts (#155) ------------------------------------------
let activeTerminalId = null;
let tabsSaveTimer = null;
// Once the quit snapshot is taken, the ptys being killed must not overwrite it.
let tabsFrozen = false;

// Chats in tabs seen alive, and the ones seen ending since (trackChatEnds):
// only an end observed during the run drops a tab's chat from the save.
const chatsSeenAlive = new Set();
const chatsEnded = new Set();
let lastTabsJson = null;

function chatsInTabs() {
  return [
    ...resumedChats.values(),
    ...linkedSessions(registry.list())
      .filter((session) => session.term?.VIZOR_PTY_ID)
      .map((session) => session.id),
  ];
}

function saveWorkspaceTabs() {
  if (tabsFrozen || !ptyHost) return;
  const snapshot = tabsToSave({
    terminals: ptyHost.list(),
    sessions: linkedSessions(registry.list()),
    ended: chatsEnded,
    activeId: activeTerminalId,
    resumed: resumedChats,
  });
  const workspaceTabs = { ...snapshot, windowOpen: Boolean(workspaceWindow?.isOpen()) };
  // Saves follow every hook event: write only what changed.
  const json = JSON.stringify(workspaceTabs);
  if (json === lastTabsJson) return;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    // Atomic: a crash mid-write must not leave a state.json that parses to
    // nothing — it also holds the bubble's place and the window bounds.
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...loadPersistedState(), workspaceTabs }));
    fs.renameSync(temp, stateFile);
    lastTabsJson = json;
  } catch (error) {
    log(`workspace tabs save failed: ${error}`);
  }
}

function scheduleTabsSave() {
  if (tabsFrozen || !ptyHost || tabsSaveTimer) return;
  tabsSaveTimer = setTimeout(() => {
    tabsSaveTimer = null;
    saveWorkspaceTabs();
  }, 500);
}

function freezeWorkspaceTabs() {
  if (tabsFrozen) return;
  clearTimeout(tabsSaveTimer);
  tabsSaveTimer = null;
  saveWorkspaceTabs();
  tabsFrozen = true;
}

// The thaw only brings tab saving back. appQuitting stays set on purpose:
// cleared, the workspace and rules windows would go back to hiding on close,
// and a quit that was merely slow (not cancelled) would then be cancelled by
// them. The rest of before-quit (socket, hooks, tray) isn't undone either.
const quitFreeze = createQuitFreeze({
  freeze: freezeWorkspaceTabs,
  thaw: () => {
    if (!tabsFrozen) return;
    log('quit did not go through: workspace tab saves resume');
    tabsFrozen = false;
    scheduleTabsSave();
  },
  hold: () => {
    clearTimeout(tabsSaveTimer);
    tabsSaveTimer = null;
    tabsFrozen = true;
  },
});

function restoreWorkspaceTabs() {
  if (!workspaceWindow) return;
  const saved = loadPersistedState().workspaceTabs;
  const plan = restorePlan({ saved, liveIds: readLiveSessionIds(), dirExists: isDirectory });
  for (const { cwd, why } of plan.skipped) log(`workspace tab not restored (${cwd}): ${why}`);
  for (const tab of plan.open) {
    const result = openTerminal({ cwd: tab.cwd, kind: tab.sessionId ? 'resume' : 'shell', sessionId: tab.sessionId });
    if (result.error) log(`workspace tab not restored (${tab.cwd}): ${result.error}`);
    else if (tab.active) activeTerminalId = result.id;
  }
  if (plan.open.length) log(`workspace: ${plan.open.length} tab(s) restored`);
  if (saved?.windowOpen && plan.open.length) workspaceWindow.show();
}

ipcMain.on('workspace:active-tab', (event, id) => {
  if (!fromWorkspace(event) || (id !== null && typeof id !== 'string')) return;
  activeTerminalId = id;
  scheduleTabsSave();
});
// When the user last typed in each tab: the gerente never types over them (#162 review).
const userTypedAt = new Map(); // pty id → time
const USER_TYPING_MS = 5000;
ipcMain.on('pty:write', (event, { id, data } = {}) => {
  if (!fromWorkspace(event) || typeof data !== 'string') return;
  userTypedAt.set(id, Date.now());
  ptyHost?.write(id, data);
});
ipcMain.on('pty:resize', (event, { id, cols, rows } = {}) => {
  const size = fromWorkspace(event) ? clampTerminalSize(cols, rows) : null;
  if (size) ptyHost?.resize(id, size.cols, size.rows);
});
ipcMain.on('pty:ack', (event, { id, chars } = {}) => {
  if (fromWorkspace(event)) ptyHost?.ack(id, Number(chars));
});
ipcMain.on('pty:close', (event, id) => {
  if (fromWorkspace(event)) ptyHost?.close(id);
});
ipcMain.on('pty:title', (event, { id, title } = {}) => {
  if (fromWorkspace(event)) ptyHost?.setTitle(id, title);
});
ipcMain.handle('pty:buffer', (event, id) => (fromWorkspace(event) ? (ptyHost?.buffer(id) ?? '') : ''));

// --- inspector (#93): the window pulls edits and files on demand --------
const editPings = new Map(); // sessionId → throttle timer

editTracker.on('change', ({ sessionId }) => {
  if (!workspaceWindow?.isReady() || editPings.has(sessionId)) return;
  editPings.set(
    sessionId,
    setTimeout(() => {
      editPings.delete(sessionId);
      workspaceWindow?.send('edits:changed', { sessionId });
    }, 150),
  );
});

function sessionWorktree(sessionId) {
  const cwd = registry.list().find((session) => session.id === sessionId)?.cwd;
  if (!cwd) return null;
  const paths = [...worktreeCache.values()].flat().map((worktree) => worktree.path);
  return matchWorktree(cwd, paths) ?? cwd;
}

function pickTask(sessionId, taskId) {
  if (!taskId) return editTracker.currentTask(sessionId);
  return editTracker.tasks(sessionId).find((task) => task.id === taskId) ?? null;
}

ipcMain.handle('edits:task', (event, { sessionId, taskId = null } = {}) => {
  if (!fromWorkspace(event) || typeof sessionId !== 'string') return { task: null, summaries: [] };
  return {
    task: serializeTask(pickTask(sessionId, taskId), sessionWorktree(sessionId)),
    summaries: taskSummaries(editTracker.tasks(sessionId)),
    comments: commentStore.list(sessionId),
  };
});

// Only files the task touched: the window must not be able to read anything
// else. The rows are cached per task and file until its contents change —
// every edit ping would otherwise re-diff the whole file on main.
const fileViewCache = new Map(); // `${taskId}\0${filePath}` → { start, current, dropped, edits, view }
// Contents dropped by the memory ceiling must not live on in this cache (#130).
editTracker.on('evicted', () => fileViewCache.clear());

ipcMain.handle('edits:file', (event, { sessionId, taskId = null, filePath } = {}) => {
  if (!fromWorkspace(event) || typeof sessionId !== 'string' || typeof filePath !== 'string')
    return { error: 'pedido inválido' };
  const task = pickTask(sessionId, taskId);
  if (!task) return { error: 'arquivo fora da tarefa' };
  const file = task.files.get(filePath);
  const edits = task.edits.filter((edit) => edit.filePath === filePath);
  const signature = edits.map((edit) => `${edit.id}:${edit.status}:${edit.endedAt}`).join('|');
  const key = `${task.id}\0${filePath}`;
  const cached = fileViewCache.get(key);
  if (
    cached &&
    cached.start === file?.start &&
    cached.current === file?.current &&
    cached.dropped === task.snapshotsDropped &&
    cached.edits === signature
  )
    return cached.view;
  const view = fileViewFor(task, filePath, sessionWorktree(sessionId));
  if (fileViewCache.size > 50) fileViewCache.clear();
  fileViewCache.set(key, { start: file?.start, current: file?.current, dropped: task.snapshotsDropped, edits: signature, view });
  return view;
});

const INSPECTOR_MODES = ['arquivo', 'cards'];
const INSPECTOR_WIDTHS = ['compact', 'wide', 'collapsed'];

ipcMain.handle('workspace:prefs', (event, { set } = {}) => {
  const saved = loadPersistedState().workspaceInspector ?? {};
  const current = {
    mode: INSPECTOR_MODES.includes(saved.mode) ? saved.mode : 'arquivo',
    width: INSPECTOR_WIDTHS.includes(saved.width) ? saved.width : 'compact',
  };
  if (!fromWorkspace(event) || !set) return current;
  const next = {
    mode: INSPECTOR_MODES.includes(set.mode) ? set.mode : current.mode,
    width: INSPECTOR_WIDTHS.includes(set.width) ? set.width : current.width,
  };
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...loadPersistedState(), workspaceInspector: next }));
  } catch (error) {
    log(`inspector prefs save failed: ${error}`);
  }
  return next;
});

// --- changes made by commands (#94) --------------------------------------
// Recorded for every session, workspace open or not — like the edits — but
// git is only polled while some session has a task running there.
const BASELINE_FILE_BYTES = MAX_DIFF_BYTES;
const BASELINE_TOTAL_BYTES = 20 * 1024 * 1024;
const baselineSnapshots = new Map(); // root → Map<abs, content> of files dirty at task start

const commandWatcher = createCommandWatcher({
  // --no-optional-locks: a background poller must never take index.lock and
  // break the AI's own `git add`/`commit` (#94 review).
  gitStatus: (root) =>
    execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    })
      .then(({ stdout }) => stdout)
      .catch(() => null),
  gitHead: (root) =>
    execFileAsync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, timeout: 3000 })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null),
  gitChangedBetween: (root, from, to) =>
    execFileAsync('git', ['--no-optional-locks', 'diff', '--name-only', '-z', from, to], {
      cwd: root,
      timeout: 3000,
      maxBuffer: 16 * 1024 * 1024,
    })
      // Full list: the watcher skips a cycle past its cap — a truncated list
      // would never trip it and become 200 arbitrary cards (review I-3).
      .then(({ stdout }) => stdout.split('\0').filter(Boolean))
      .catch(() => null),
  statFile: (abs) =>
    fs.promises.stat(abs).then(
      (stats) => `${stats.size}:${stats.mtimeMs}`,
      () => 'gone',
    ),
  // A change is explained by an edit still in flight in ANY session; landed
  // edits are matched by content in recordCommandChange.
  explained: (_owners, abs) => editTracker.explains(abs, realPathOf),
  onChange: (change) => {
    reviewService.invalidate(change.root);
    recordCommandChange(change).catch((error) => log(`command change failed: ${error}`));
  },
  // The user's uncommitted work at task start: a later command change is
  // diffed against THIS, never against the index (#94 review).
  onBaseline: ({ root, files }) => {
    const snapshot = new Map();
    let total = 0;
    for (const file of files) {
      try {
        const { size } = fs.statSync(file);
        if (size > BASELINE_FILE_BYTES || total + size > BASELINE_TOTAL_BYTES) continue;
        snapshot.set(file, fs.readFileSync(file, 'utf8'));
        total += size;
      } catch {
        // gone or unreadable: nothing to remember
      }
    }
    baselineSnapshots.set(root, snapshot);
  },
  log,
});

async function readForCommand(filePath) {
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch (error) {
    return { content: null, note: error?.code === 'ENOENT' ? 'deleted' : 'unreadable' };
  }
  if (!stats.isFile()) return { content: null, note: 'unreadable' };
  // Size first: a giant file is never read just to be refused.
  if (stats.size > MAX_DIFF_BYTES) return { content: null, note: 'too-large' };
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const verdict = diffability(content);
    return verdict === 'ok' ? { content, note: null } : { content: null, note: verdict };
  } catch {
    return { content: null, note: 'unreadable' };
  }
}

async function readHeadVersion(root, head, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return execFileAsync('git', ['--no-optional-locks', 'show', `${head}:${relative}`], {
    cwd: root,
    timeout: 3000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .then(({ stdout }) => stdout)
    .catch(() => null); // not at that HEAD, or git failed: fall back to the other baselines
}

async function recordCommandChange({ root, filePath, owners, untracked, fromHead }) {
  const { content: after, note: readNote } = await readForCommand(filePath);
  // An edit's own write (its Post landed after the poll): not a command's.
  if (after !== null && editTracker.contentsAnywhere(filePath, realPathOf).includes(after)) return;
  for (const owner of owners) {
    const session = registry.list().find((item) => item.id === owner);
    // Esc ends a turn without a Stop hook: the session is idle, the change is
    // the user's — close the task instead of blaming the AI (#94 review).
    if (session?.transcriptPath && (await readInterrupted(session.transcriptPath))) {
      editTracker.endTask(owner);
      continue;
    }
    let note = readNote;
    let before = editTracker.knownContent(owner, filePath);
    let baseline = before === null ? null : 'previous';
    if (before === null && baselineSnapshots.get(root)?.has(filePath)) {
      before = baselineSnapshots.get(root).get(filePath);
      baseline = 'task-start';
    }
    if (before === null && fromHead) {
      before = await readHeadVersion(root, fromHead, filePath);
      baseline = 'head';
    }
    if (before === null && after !== null) {
      if (untracked) {
        before = '';
        baseline = 'created';
      } else {
        before = await readIndexVersion(filePath);
        baseline = before === null ? 'none' : 'git';
      }
    }
    if (before !== null && diffability(before) !== 'ok') {
      note = diffability(before);
      before = null;
    }
    // A touch, a no-op formatter, stash/pop: nothing to show.
    if (before !== null && before === after) continue;
    const command = session?.transcriptPath ? await readLastBashCommand(session.transcriptPath) : null;
    const edit = editTracker.addCommandEdit(owner, {
      filePath,
      before,
      after,
      baseline,
      reason: commandReason(command),
      note,
      uncertainOwner: owners.length > 1,
    });
    logEdit(edit);
  }
}

// Hooks may report a path through a symlink that git reports resolved: compare
// real paths (#132). Cached — called per tracked file on every comparison.
const realPaths = new Map();
function realPathOf(file) {
  if (realPaths.has(file)) return realPaths.get(file);
  try {
    const real = fs.realpathSync(file);
    if (realPaths.size > 5000) realPaths.clear();
    realPaths.set(file, real);
    return real;
  } catch {
    // Not there yet (a Write still waiting on permission): resolve the
    // folder, and never cache — the file may appear in a moment (review M-4).
    try {
      return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return file;
    }
  }
}

const COMMAND_ROOT_RETRY_MS = 60000;
const commandRootCache = new Map(); // session cwd → { root, at } (null roots retried after a minute)
let commandRootsTimer = null;

// Which worktrees to poll, and for whom: sessions with a task running,
// grouped by the worktree checkout their cwd is in (linked ones included).
async function refreshCommandRoots() {
  const owners = new Map();
  for (const session of registry.list()) {
    const task = editTracker.currentTask(session.id);
    if (!session.cwd || !task || task.endedAt !== null) continue;
    const cached = commandRootCache.get(session.cwd);
    if (!cached || (cached.root === null && Date.now() - cached.at > COMMAND_ROOT_RETRY_MS))
      commandRootCache.set(session.cwd, { root: await worktreeRootOf(session.cwd), at: Date.now() });
    const root = commandRootCache.get(session.cwd).root;
    if (!root) continue;
    owners.set(root, [...(owners.get(root) ?? []), session.id]);
  }
  for (const root of commandWatcher.activeRoots())
    if (!owners.has(root)) {
      commandWatcher.setActive(root, []);
      baselineSnapshots.delete(root);
    }
  for (const [root, sessions] of owners) commandWatcher.setActive(root, sessions);
}

function scheduleCommandRoots() {
  if (commandRootsTimer) return;
  commandRootsTimer = setTimeout(() => {
    commandRootsTimer = null;
    refreshCommandRoots().catch((error) => log(`command roots failed: ${error}`));
  }, 200);
}

editTracker.on('task', scheduleCommandRoots);
editTracker.on('change', scheduleCommandRoots);

// --- 💬 comments on a change (#95) -----------------------------------------
const commentStore = createCommentStore();
// Is the session's own claude the job in front of that Vizor terminal? Its
// pid comes from Claude Code's session registry; /proc says whether it leads
// the terminal's foreground group, on THAT pty, and isn't stopped.
function claudeInPty(session, ptyId) {
  const tty = ptyHost?.ttyPath(ptyId);
  const pid = session?.id ? readSessionPid(session.id) : null;
  if (!tty || !pid) return false;
  try {
    return inForeground({ stat: fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), ttyRdev: fs.statSync(tty).rdev });
  } catch {
    return false;
  }
}

const commentDelivery = createCommentDelivery({
  store: commentStore,
  sessionOf: (sessionId) => linkedSession(sessionId),
  claudeInPty,
  writePty: (ptyId, data) => ptyHost?.write(ptyId, data),
  sendPeer: (session, text) => sendPeerMessage(session, text),
  typeReply: (session, text) => typeIntoTerminal(session, text),
  log,
});

// Same ping as the edits: the inspector re-reads the session.
commentStore.on('change', ({ sessionId }) => {
  if (workspaceWindow?.isReady()) workspaceWindow.send('edits:changed', { sessionId });
});

ipcMain.handle('comments:add', async (event, { sessionId, editId, text } = {}) => {
  if (!fromWorkspace(event) || typeof sessionId !== 'string' || typeof editId !== 'string')
    return { ok: false, error: 'pedido inválido' };
  const valid = validateComment(text);
  if (!valid.ok) return valid;
  const task = editTracker.tasks(sessionId).find((item) => item.edits.some((edit) => edit.id === editId));
  const edit = task
    ? serializeTask({ ...task, edits: task.edits.filter((item) => item.id === editId) }, sessionWorktree(sessionId)).edits[0]
    : null;
  if (!edit) return { ok: false, error: 'mudança não encontrada' };
  commentStore.add({ sessionId, editId, text: valid.text, message: buildCommentMessage(edit, valid.text) });
  // immediate: the user just pressed Enviar — the only moment typing into a
  // terminal window is acceptable.
  commentDelivery
    .flush(sessionId, { immediate: true })
    .then(() => flushHeldComments())
    .catch((error) => log(`comment flush failed: ${error}`));
  return { ok: true };
});

// "copiar" on a comment that could not be delivered: the clipboard is only
// ever written because the user asked.
ipcMain.handle('comments:copy', (event, { sessionId, commentId } = {}) => {
  if (!fromWorkspace(event)) return false;
  const comment = commentStore.list(sessionId).find((item) => item.id === commentId);
  if (!comment) return false;
  clipboard.writeText(comment.message);
  return true;
});

let knownSessionIds = new Set();
function forgetRemovedSessions() {
  const current = registry.list().map((session) => session.id);
  for (const sessionId of removedIds(knownSessionIds, current)) {
    editTracker.forgetSession(sessionId);
    commentStore.forgetSession(sessionId);
  }
  knownSessionIds = new Set(current);
}

// A session that stops waiting gets its held comments. A comment held only
// because a fresh notice hasn't settled is retried a moment later, since no
// registry change will come to wake it.
let heldRetryTimer = null;
function flushHeldComments() {
  let pending = false;
  for (const session of registry.list())
    if (commentStore.nextToSend(session.id, session)) {
      pending = true;
      commentDelivery.flush(session.id).catch((error) => log(`comment flush failed: ${error}`));
    }
  if (pending && !heldRetryTimer)
    heldRetryTimer = setTimeout(() => {
      heldRetryTimer = null;
      flushHeldComments();
    }, 3500);
}

ipcMain.on('workspace:selected', (event, sessionId) => {
  if (fromWorkspace(event)) workspaceSelectedSession = typeof sessionId === 'string' ? sessionId : null;
});

// --- review screen (#revisão, phase 1) --------------------------------------
// Wiring only: the logic lives in src/main/review/. The renderer asks through
// IPC, and a worktree it names must be one the workspace already knows.
const reviewRoots = new Set(); // worktrees the verifier may have processes in

// git for the review service: stdin for `apply`/`cat-file --batch`, room for a
// whole `git diff`. --no-optional-locks: it must never block the AI's own git.
const reviewGit = (args, cwd, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on('error', () => {}); // git exited before reading all of it
    child.stdin?.end(stdin ?? '');
  });

const reviewVerifier = createVerifier({ spawn });
const reviewStores = new Map(); // worktree → { load, approve, prune, setPrefs, prefs }
function reviewStoreFor(worktree) {
  let entry = reviewStores.get(worktree);
  if (!entry) {
    const store = createReviewStore({
      readFile: (file, encoding) => fs.promises.readFile(file, encoding),
      writeFile: (file, data) => fs.promises.writeFile(file, data),
      rename: (from, to) => fs.promises.rename(from, to),
      mkdir: (dir, options) => fs.promises.mkdir(dir, options),
      onError: (error) => log(`review state save failed: ${error}`),
      dir: path.join(configDir, 'revisao'),
      key: storeKey(worktree),
      setTimeout,
      clearTimeout,
    });
    // load() resets what is in memory: it runs once, for the service and for prefs alike.
    let loaded = null;
    let prefs = {};
    const load = () => (loaded ??= store.load().then((result) => { prefs = result.prefs; return result; }));
    entry = {
      load,
      approve: (id, on) => store.approve(id, on),
      prune: (ids) => store.prune(ids),
      flush: () => store.flush(),
      setPrefs(partial) { prefs = { ...prefs, ...partial }; store.setPrefs(partial); },
      async prefs() { await load(); return prefs; },
    };
    reviewStores.set(worktree, entry);
  }
  return entry;
}

const reviewSessionsIn = (worktree) => registry.list().filter((session) => sessionWorktree(session.id) === worktree);

const reviewService = createReviewService({
  git: reviewGit,
  readFile: (file, encoding) => fs.promises.readFile(file, encoding),
  stat: (file) => fs.promises.stat(file),
  graphFor,
  graphBuilt: (root) => graphIndexers.get(root)?.graph() ?? null,
  verifier: reviewVerifier,
  storeFor: reviewStoreFor,
  sessionsOf: reviewSessionsIn,
  // Nothing runs before the workspace window first shows (its 'show' resumes it).
  startPaused: true,
  log,
});

const sendReviewChanged = (worktree) => {
  if (workspaceWindow?.isReady()) workspaceWindow.send('review:changed', { worktree });
};
// The service holds its own notices while paused; the rest (a graph batch,
// an issue body, a first prompt landing) wait here while the window is hidden
// and go out once when it shows again.
let reviewWindowHidden = true; // until the workspace window first shows
const reviewHeldNotices = new Set();
const notifyReview = (worktree) => {
  if (reviewWindowHidden) reviewHeldNotices.add(worktree);
  else sendReviewChanged(worktree);
};
reviewService.on('changed', sendReviewChanged);

// What the dev asked for: the linked issue, else the chat's first prompt (read
// off the main loop once; the screen is told when it lands).
const firstPrompts = new Map(); // sessionId → text | null
const ISSUE_BODY_MAX = 4000;
const issueBodies = new Map(); // `${repo}#${number}` → body ('' while loading or on failure)
const issueRepos = new Map(); // project root → owner/repo | null
function issueBodyFor(project, number, worktree) {
  const known = issueRepos.get(project);
  if (known === undefined) {
    issueRepos.set(project, null);
    runText('git', ['remote', 'get-url', 'origin'], { cwd: project })
      .then((remote) => { issueRepos.set(project, githubRepoOf(remote)); notifyReview(worktree); })
      .catch((error) => log(`review: no origin for ${project}: ${error}`));
    return '';
  }
  if (!known) return '';
  const key = `${known}#${number}`;
  if (!issueBodies.has(key)) {
    issueBodies.set(key, '');
    runText('gh', ['issue', 'view', String(number), '--json', 'body', '-q', '.body', '-R', known], { cwd: project })
      .then((body) => { issueBodies.set(key, body.trim().slice(0, ISSUE_BODY_MAX)); notifyReview(worktree); })
      .catch((error) => log(`review: issue body ${key} failed: ${error}`));
  }
  return issueBodies.get(key);
}

function reviewRequestOf(worktree) {
  const sessions = reviewSessionsIn(worktree);
  const project = [...worktreeCache].find(([, trees]) => (trees ?? []).some((tree) => tree.path === worktree))?.[0] ?? worktree;
  for (const session of sessions) {
    const number = taskLinks.numberOf(project, session.id);
    const issue = number && lastGhResultsRoot === project ? lastGhResults?.openIssues?.find((item) => item.number === number) : null;
    if (issue) return { kind: 'issue', number, title: issue.title ?? '', body: issueBodyFor(project, number, worktree) };
  }
  const session = sessions.find((item) => item.id === workspaceSelectedSession && item.transcriptPath) ?? sessions.find((item) => item.transcriptPath);
  if (!session) return null;
  if (!firstPrompts.has(session.id)) {
    firstPrompts.set(session.id, null);
    readFirstPrompt(session.transcriptPath).then((text) => {
      if (!text) return;
      firstPrompts.set(session.id, text);
      notifyReview(worktree);
    });
  }
  const text = firstPrompts.get(session.id);
  return text ? { kind: 'prompt', text } : null;
}
reviewService.setRequestSource(reviewRequestOf);

function reviewInvalidate(sessionId) {
  const worktree = sessionWorktree(sessionId);
  if (worktree) reviewService.invalidate(worktree);
}
function reviewAgentStopped(sessionId) {
  const worktree = sessionWorktree(sessionId);
  if (!worktree) return;
  reviewService.invalidate(worktree);
  reviewRoots.add(worktree);
  reviewService.onAgentStop(worktree).catch((error) => log(`review tsc after stop failed: ${error}`));
}

function reviewWorktreeOk(worktree) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) return false;
  const known = workspaceProjects().includes(worktree)
    || [...worktreeCache.values()].some((trees) => (trees ?? []).some((tree) => tree.path === worktree))
    || registry.list().some((session) => sessionWorktree(session.id) === worktree);
  if (known) reviewRoots.add(worktree);
  return known;
}

// Every handler answers a safe value: a git failure never reaches the renderer as a throw.
function reviewHandle(channel, fallback, run) {
  ipcMain.handle(channel, async (event, args = {}) => {
    if (!fromWorkspace(event)) return fallback('pedido inválido');
    try {
      return await run(args ?? {});
    } catch (error) {
      log(`${channel} failed: ${error}`);
      return fallback('não deu pra ler o repositório');
    }
  });
}
const reviewFail = (error) => ({ ok: false, error });
const BAD_REVIEW_REQUEST = 'pedido inválido';

reviewHandle('review:summary', () => null, ({ worktree }) => (reviewWorktreeOk(worktree) ? reviewService.summary(worktree) : null));
// force: the dev clicked "abrir mesmo assim" on a diff over 3,000 lines.
reviewHandle('review:file', () => null, ({ worktree, path: rel, force }) =>
  reviewWorktreeOk(worktree) && safeRelPath(rel) ? reviewService.file(worktree, rel, { force: force === true }) : null);
reviewHandle('review:approve', reviewFail, async ({ worktree, hunkId, on }) => {
  if (!reviewWorktreeOk(worktree) || typeof hunkId !== 'string') return reviewFail(BAD_REVIEW_REQUEST);
  await reviewService.approve(worktree, hunkId, Boolean(on));
  return { ok: true };
});
reviewHandle('review:slice', (reason) => ({ status: 'unavailable', reason }), ({ worktree, expanded, showHidden }) =>
  reviewWorktreeOk(worktree)
    ? reviewService.slice(worktree, { expanded: Array.isArray(expanded) ? expanded.filter((id) => typeof id === 'string') : [], showHidden: Boolean(showHidden) })
    : { status: 'unavailable', reason: BAD_REVIEW_REQUEST });
reviewHandle('review:verify', reviewFail, async ({ worktree, kind }) => {
  if (!reviewWorktreeOk(worktree) || (kind !== 'tsc' && kind !== 'tests')) return reviewFail(BAD_REVIEW_REQUEST);
  return reviewService.verify(worktree, kind);
});
reviewHandle('review:prefs', () => ({}), async ({ worktree, set }) => {
  if (!reviewWorktreeOk(worktree)) return {};
  const store = reviewStoreFor(worktree);
  await store.prefs(); // load() resets the store: a set before it lands would be wiped
  const clean = sanitizePrefs(set);
  if (Object.keys(clean).length) store.setPrefs(clean);
  return store.prefs();
});

// The composer and the "Desfiz" notice ride the 💬 channel: same queue, same
// guarantee of never typing into a dialog; immediate because the dev just clicked.
function sendReviewMessage(sessionId, text, message) {
  commentStore.add({ sessionId, editId: `review:${createHash('sha1').update(message).digest('hex').slice(0, 12)}`, text, message });
  commentDelivery
    .flush(sessionId, { immediate: true })
    .then(() => flushHeldComments())
    .catch((error) => log(`comment flush failed: ${error}`));
}

reviewHandle('review:compose', reviewFail, ({ sessionId, context, text }) => {
  if (typeof sessionId !== 'string' || !registry.sessions.has(sessionId)) return reviewFail('chat não encontrado');
  const composed = composeMessage(context ?? null, text);
  if (!composed.ok) return composed;
  sendReviewMessage(sessionId, composed.text, composed.message);
  return { ok: true };
});

reviewHandle('review:reject', reviewFail, async ({ worktree, path: rel, hunkId, sessionId }) => {
  if (!reviewWorktreeOk(worktree) || !safeRelPath(rel) || typeof hunkId !== 'string') return reviewFail(BAD_REVIEW_REQUEST);
  // The line has to be read before the hunk is gone.
  // force: over 3,000 lines the view is cut, but the hunk still has to be found.
  const hunk = (await reviewService.file(worktree, rel, { force: true }))?.hunks?.find((item) => item.id === hunkId);
  const result = await reviewService.reject(worktree, rel, hunkId);
  if (result.ok && hunk && typeof sessionId === 'string' && registry.sessions.has(sessionId)) {
    const notice = rejectNotice(rel, hunk.newStart);
    sendReviewMessage(sessionId, notice, notice);
  }
  return result;
});

// Hidden or minimized: no recompute, and the graphs are dropped after 10 min.
workspaceWindow?.onVisibility((visible) => {
  reviewWindowHidden = !visible;
  if (visible) {
    disarmGraphDiscard();
    reviewService.resume();
    // What landed while hidden, plus the worktree on screen (its graph may have been dropped and rebuilt),
    // ride the service's debounce: with the dirty flush and the focus invalidate, one recompute each.
    const selected = workspaceSelectedSession ? sessionWorktree(workspaceSelectedSession) : null;
    if (selected) reviewHeldNotices.add(selected);
    for (const worktree of reviewHeldNotices) reviewService.notify(worktree);
    reviewHeldNotices.clear();
  } else {
    reviewService.pause();
    armGraphDiscard();
  }
});

function onWorkspaceFocus() {
  if (workspaceSelectedSession) reviewInvalidate(workspaceSelectedSession);
}

// Edit-tool hooks feed the workspace's edit tracking, never the session
// registry: they say nothing about whether the session is waiting or done.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function onToolEvent(event) {
  // Bash/Task/Agent come through for the voice narration only (#161).
  if (!EDIT_TOOLS.has(event?.tool_name)) return;
  // The plan file is the card's, not a change to review.
  if (isPlanEdit(event)) return;
  editPipeline
    .push(event)
    .then((edit) => {
      if (edit && event.hook_event_name === 'PostToolUse') logEdit(edit);
    })
    .catch((error) => log(`edit capture failed: ${error}`));
}

function logEdit(edit) {
  const where = `${edit.baseline ?? '-'}${edit.note ? ` ${edit.note}` : ''}`;
  const reason = JSON.stringify(edit.reason?.slice(0, 60) ?? null);
  log(`edit #${edit.seq} ${path.basename(edit.filePath)} +${edit.added} −${edit.removed} [${where}] ${reason}`);
}

// A VIZOR_PTY_ID that doesn't hold (no such tab in this run, or the session
// runs on another terminal — e.g. a terminal app started from a tab) is
// dropped: the session is treated as an outside one (#140).
const ptyIdentityHolds = createPtyIdentityCheck({
  ttyPath: (ptyId) => ptyHost?.ttyPath(ptyId) ?? null,
  ttyRdev: (tty) => fs.statSync(tty).rdev,
  readSessionPid: (sessionId) => readSessionPid(sessionId),
  readStat: (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  },
});

function verifiedTerm(event) {
  const ptyId = event?.term?.VIZOR_PTY_ID;
  if (!ptyId) return event;
  if (ptyIdentityHolds(event.session_id, ptyId)) return event;
  const { VIZOR_PTY_ID: _dropped, ...rest } = event.term;
  return { ...event, term: Object.keys(rest).length ? rest : undefined, dropPtyId: true };
}

function onHookEvent(event, reply) {
  // Only while the Maestro is on: off, nothing would ever forget it (review I2).
  if (maestroOn()) backstage.onEvent(event);
  // Sub-agent starts and stops are the backstage's only (#142).
  if (event?.hook_event_name === 'SubagentStart' || event?.hook_event_name === 'SubagentStop') return;
  if (event?.type === 'guard-ask' || event?.type === 'guard-event') {
    onGuardMessage(event, reply);
    return;
  }
  event = verifiedTerm(event);
  // A chat the voice opened for a task: its first event names its session.
  const newChat = event?.term?.VIZOR_PTY_ID && pendingNewChats.get(event.term.VIZOR_PTY_ID);
  if (newChat && event.session_id) {
    pendingNewChats.delete(event.term.VIZOR_PTY_ID);
    newChat({ sessionId: event.session_id });
  }
  workPlans
    .onEvent(event)
    .then((changed) => {
      if (!changed) return;
      // Its Vizor-plano line lights the planned files on the graph, dashed (#159).
      const playing = maestroOrchestra.find((musician) => musician.sessionId === event.session_id);
      const planned = playing?.root ? parsePlan(workPlans.textOf(event.session_id), playing.root) : [];
      if (planned.length) maestroPlans.set(event.session_id, planned);
      pushWorkspaceState();
    })
    .catch((error) => log(`plan follow failed: ${error}`));
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event?.hook_event_name)) {
    voiceSession?.onToolEvent(event);
    maestroNarrate(event);
    const verdict = testOutcomeOf(event);
    if (verdict && event.session_id) turnTests.set(event.session_id, verdict);
    if (event.hook_event_name === 'PostToolUse' && EDIT_TOOLS.has(event.tool_name) && !isPlanEdit(event)) {
      graphTouched(event);
      reviewInvalidate(event.session_id);
    }
  }
  // The chat speaks for itself now: its own term says which tab (if any) it
  // runs in, so the resume mapping would only go stale (review I-2).
  for (const [ptyId, sessionId] of resumedChats) if (sessionId === event?.session_id) resumedChats.delete(ptyId);
  if (event?.hook_event_name === 'PreToolUse' || event?.hook_event_name === 'PostToolUse') {
    onToolEvent(event);
    return;
  }
  // A failed command: only the narration and the conductor read it (no edit landed).
  if (event?.hook_event_name === 'PostToolUseFailure') return;
  if (event?.hook_event_name === 'Notification') {
    event = {
      ...event,
      permissionAsk: isPermissionAsk(event.message),
      message: humanizeNotification(event.message, Math.random, spokenLang()),
    };
  }
  // Task boundaries ride the same per-session chain as the edits, so an
  // edit still queued from this prompt can't land in the next one.
  if (event?.hook_event_name === 'Stop') reviewAgentStopped(event.session_id);
  if (event?.hook_event_name === 'UserPromptSubmit' || event?.hook_event_name === 'Stop')
    editPipeline.push(event).catch((error) => log(`edit task tracking failed: ${error}`));
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

ipcMain.on('session:remove', (_event, sessionId) => {
  registry.remove(sessionId);
  editTracker.forgetSession(sessionId);
  commentStore.forgetSession(sessionId);
});

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
function withTranscript(record) {
  const transcriptPath = claudeTranscriptPath(record.cwd, record.sessionId);
  return { ...record, transcriptPath: fs.existsSync(transcriptPath) ? transcriptPath : null };
}

ipcMain.handle('sessions:rescan', () => {
  const records = readAdoptableSessions();
  if (!records) return 0;
  return registry.adopt(records.map(withTranscript));
});

// A chat resumed in a tab sends no hook event until the user types: adopt it
// from Claude Code's own registry so the sidebar lists it meanwhile (#155).
function adoptResumedChats() {
  if (appQuitting) return;
  const missing = new Set([...resumedChats.values()].filter((sessionId) => !registry.sessions.has(sessionId)));
  if (!missing.size) return;
  const records = readAdoptableSessions()?.filter((record) => missing.has(record.sessionId));
  if (records?.length) registry.adopt(records.map(withTranscript));
}

// A manual "apply" restarts the app too: with workspace terminals alive it
// asks first, like any quit from the UI.
ipcMain.on('update:apply', async () => {
  const prompt = quitPrompt(ptyHost?.aliveCount() ?? 0);
  if (prompt) {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Atualizar o Vizor', ...prompt });
    if (response !== 0) return;
  }
  applyUpdate();
});

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
  if (voiceArbiter) {
    voiceArbiter.say({ text, priority: 4, source: 'alert' });
    return;
  }
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
  voices: Object.entries(VOICES).map(([value, spec]) => ({ value, label: spec.label, lang: spec.lang })),
  themes: Object.entries(THEMES).map(([value, spec]) => ({ value, label: spec.label })),
  palettes: Object.entries(PALETTES).map(([value, spec]) => ({ value, label: spec.label })),
  panelScaleRange: PANEL_SCALE,
}));

// The settings window and the tray menu both change the config through here.
function applyConfig(partial) {
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
  if (typeof partial?.voiceEnabled === 'boolean') allowed.voiceEnabled = partial.voiceEnabled;
  if (partial?.voiceModel === 'parakeet' || partial?.voiceModel === 'base') allowed.voiceModel = partial.voiceModel;
  if (typeof partial?.voiceNarration === 'boolean') allowed.voiceNarration = partial.voiceNarration;
  if (['always', 'short', 'off'].includes(partial?.voiceSummary)) allowed.voiceSummary = partial.voiceSummary;
  if (partial && 'voiceMic' in partial) allowed.voiceMic = normalizeMic(partial.voiceMic);
  if (typeof partial?.maestroEnabled === 'boolean') allowed.maestroEnabled = partial.maestroEnabled;
  if (partial && 'audioOutput' in partial) allowed.audioOutput = normalizeOutput(partial.audioOutput);
  const micChanged = 'voiceMic' in allowed && JSON.stringify(allowed.voiceMic) !== JSON.stringify(managerConfig.voiceMic ?? null);
  const voiceRestart = ('voiceEnabled' in allowed && allowed.voiceEnabled !== managerConfig.voiceEnabled) ||
    ('voiceModel' in allowed && allowed.voiceModel !== managerConfig.voiceModel);
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
  if ('audioOutput' in allowed) tts.setAudioOutput(managerConfig.audioOutput);
  if ('audioOutput' in allowed || 'voiceMic' in allowed) refreshTrayMenu();
  if ('maestroEnabled' in allowed) {
    if (!allowed.maestroEnabled) {
      maestroOrder.cancel();
      maestroConductor.clear(); // no order left to fire on a later, unrelated stop
      // The graphs stay: the review screen uses them; the hidden-window timer drops them.
    }
    pushWorkspaceState();
  }
  if ('audioOutput' in allowed && managerConfig.audioOutput && !chromiumSinkId(chromiumOutputs, managerConfig.audioOutput))
    log(`audio output: no Chromium match for "${managerConfig.audioOutput.label}" (${chromiumOutputs.map((device) => device.label).join(' | ')}) — chimes stay on the default`);
  // Muted by voice, the mic stays off: it only learns which one to open next.
  if (micChanged)
    micWindow?.webContents.send('mic:control', { command: voiceState === 'muted' ? 'stop' : 'restart', mic: managerConfig.voiceMic });
  try {
    saveConfig(configFile, managerConfig);
  } catch (error) {
    log(`config save failed: ${error}`);
  }
  if (voiceRestart) {
    stopVoice();
    if (managerConfig.voiceEnabled) enableVoice();
  }
  sendState();
  if (allowed.panelScale && overlayMode === 'panel') showOverlay('panel', { focus: true });
  if (allowed.panelScale && settingsVisible()) openSettingsWindow();
  // Speaking the sample also pulls the model when it is not there yet.
  if (allowed.voice)
    tts.speak(speechLang(allowed.voice) === 'en' ? 'Voice switched. This is how I sound now!' : 'Voz trocada. Agora eu falo assim!', { voice: allowed.voice });
  if (allowed.shortcuts) {
    applyShortcuts();
    sendState(); // failures are only known after the re-register
  }
  // Turning TTS on is the moment the voice starts being needed — download it
  // now instead of on the first spoken line.
  if (allowed.ttsEnabled === true) tts.predownloadVoice(managerConfig.voice);
  return managerConfig;
}

ipcMain.handle('config:set', (_event, partial) => applyConfig(partial));

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
  const parts = hintAnnouncement(hint, spokenLang());
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
  const session = linkedSession(sessionId);
  // A session born in the Vizor lives in a workspace tab: no window hunt.
  if (session?.term?.VIZOR_PTY_ID && workspaceWindow) {
    if (overlayMode === 'panel') hideOverlay();
    workspaceWindow.focusSession(session.id);
    return 'focused';
  }
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
  const session = linkedSession(sessionId);
  const index = Number(optionIndex);
  if (!session || !Number.isInteger(index) || index < 0) return 'failed';

  // Sending the option's own text beats simulating Down x N + Return: it needs
  // no window, and it cannot land on the wrong option if the list scrolled.
  const ptyId = session.term?.VIZOR_PTY_ID;
  if (ptyId && answerRoute({ session, claudeInFront: claudeInPty(session, ptyId) }) === 'pty') {
    // One answer at a time per session: two chip clicks would mix arrows.
    if (answering.has(sessionId)) return 'failed';
    answering.add(sessionId);
    try {
      // The question the panel shows may be stale (answered in the terminal,
      // replaced by a permission prompt): only press keys if the transcript
      // still has THIS question pending, and the index is one of its options.
      const fresh = session.transcriptPath
        ? (await readTranscriptSnapshot(session.transcriptPath)).pendingQuestion
        : null;
      const shown = session.question?.questions?.[0];
      const same =
        fresh?.questions?.length === 1 &&
        fresh.questions[0].question === shown?.question &&
        JSON.stringify(fresh.questions[0].options) === JSON.stringify(shown?.options);
      if (!same || index >= shown.options.length) return 'failed';
      ptyHost.write(ptyId, answerKeys(index));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!claudeInPty(session, ptyId) || registry.sessions.get(sessionId)?.needsPermission) return 'failed';
      ptyHost.write(ptyId, '\r');
      registry.markAnswered(sessionId);
      return 'answered';
    } finally {
      answering.delete(sessionId);
    }
  }
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
async function sendPeerMessage(session, text, { priority = null } = {}) {
  const channel = session?.id ? readSessionChannel(session.id) : null;
  if (!channel) return 'no-channel';
  const outcome = await sendUserMessage(channel.socketPath, text, {
    token: channel.token,
    ...(priority ? { priority } : {}),
  });
  if (outcome !== 'sent') log(`peer channel unusable for ${session.id} (${outcome}) — falling back to the terminal`);
  return outcome;
}

async function replyToSession(session, text) {
  // A panel reply is the user reacting to this chat right now — jump the
  // queue instead of waiting for whatever turn is in flight to finish.
  const peer = await sendPeerMessage(session, text, { priority: 'now' });
  if (peer === 'sent') return 'sent';
  // A channel that answered but did not close may have delivered it: typing it
  // too would send the reply twice (same rule as comments, #138).
  if (peer === 'failed') return 'failed';
  return typeIntoTerminal(session, text);
}

async function typeIntoTerminal(session, text) {
  return terminal.sendReplyToWarp(await sessionSearchKeys(session), text, {
    writeClipboard: (value) => clipboard.writeText(value),
    terminal: managerConfig.terminal,
    allowInputInjection: displayMode.canInjectInput,
    driver: (await windowDriver()).driver,
    ...sessionFocusTarget(session),
  });
}

ipcMain.handle('warp:reply', async (_event, { sessionId, text }) => {
  const session = linkedSession(sessionId);
  const reply = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!reply) return 'failed';
  const ptyId = session?.term?.VIZOR_PTY_ID;
  if (ptyId && replyRoute({ session, claudeInFront: claudeInPty(session, ptyId) }) === 'pty') {
    ptyHost.write(ptyId, bracketedPaste(reply));
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (claudeInPty(session, ptyId)) {
      ptyHost.write(ptyId, '\r');
      return 'sent';
    }
    // The paste is already in the terminal, without Enter: say so (#143).
    return 'pasted';
  }
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
    activateBubble();
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

// null = the file exists but does not read as settings: every writer below
// leaves it alone rather than replace the user's config with only our hooks.
function readClaudeSettings() {
  const settings = readClaudeSettingsFile(() => fs.readFileSync(claudeSettingsPath, 'utf8'));
  if (!settings) log(`${claudeSettingsPath} is unreadable: left untouched`);
  return settings;
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
    if (!settings) return;
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
    if (!settings) return;
    const next = ensureHooks(settings, command);
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    writeClaudeSettings(next);
    log(`hooks self-installed: ${command}`);
  } catch (error) {
    log(`ensureHooksInstalled failed: ${error}`);
  }
}

// The rule guard (#160) lives in its own hook, copied to a stable path so it
// keeps working with the app closed (an AppImage mount vanishes on quit). Its
// state flags (guardInstalled, guardOffline, rulesUnreadable) sit near the top.
function approvedRuleCount() {
  const rules = loadRules((file) => fs.readFileSync(file, 'utf8'), rulesDir);
  if (!rules) return 0;
  return rules.global.length + Object.values(rules.repos).reduce((sum, list) => sum + list.length, 0);
}

function findNodeOnPath() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // next PATH entry
    }
  }
  return null;
}

function copyGuardScript() {
  const target = installGuardScript({ source: path.join(currentDir, '..', 'hook', 'rule-guard.js'), dir: guardDir });
  // The .js copy of the first builds is never run again.
  fs.rmSync(path.join(guardDir, 'rule-guard.js'), { force: true });
  return target;
}

function syncGuardHook() {
  try {
    const compiledFile = path.join(rulesDir, 'compiladas.json');
    rulesUnreadable = fs.existsSync(compiledFile) && !loadRules((file) => fs.readFileSync(file, 'utf8'), rulesDir);
    const settings = readClaudeSettings();
    if (!settings) return;
    let next;
    if (managerConfig.guardEnabled !== false && approvedRuleCount() > 0) {
      const { command, offline, shim } = guardCommand({
        platform: process.platform,
        execPath: process.execPath,
        appImage: process.env.APPIMAGE,
        findNode: findNodeOnPath,
        scriptPath: copyGuardScript(),
        shimDir: configDir,
      });
      if (shim) {
        fs.mkdirSync(path.dirname(shim.path), { recursive: true });
        fs.writeFileSync(shim.path, shim.content);
      }
      guardOffline = offline;
      guardInstalled = true;
      next = ensureGuard(settings, command);
    } else {
      guardInstalled = false;
      next = removeGuard(settings);
    }
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    writeClaudeSettings(next);
    log(`rule guard ${guardInstalled ? 'installed' : 'removed'}`);
  } catch (error) {
    log(`syncGuardHook failed: ${error}`);
  }
}

function removeGuardIfOnlineOnly() {
  if (!guardInstalled || guardOffline) return;
  try {
    const settings = readClaudeSettings();
    if (!settings) return;
    const next = removeGuard(settings);
    if (JSON.stringify(next) !== JSON.stringify(settings)) writeClaudeSettings(next);
    log('rule guard removed on quit (no offline runtime)');
  } catch (error) {
    log(`removeGuardIfOnlineOnly failed: ${error}`);
  }
}

function guardStatus() {
  const snapshot = rulesStore.snapshot();
  const repos = Object.values(snapshot.repos);
  return {
    enabled: managerConfig.guardEnabled !== false,
    installed: guardInstalled,
    offline: guardOffline,
    active: snapshot.global.approved.length + repos.filter((repo) => repo.compiled).reduce((sum, repo) => sum + repo.approved.length, 0),
    pending: snapshot.global.pending.length + repos.reduce((sum, repo) => sum + repo.pending.length, 0),
    unreadable: rulesUnreadable,
  };
}

// --- Rules window (#160) ----------------------------------------------------

let rulesWindow = null;
const rulesRootCache = new Map(); // cwd → repo root (main checkout) | null
const rulesSynced = new Map(); // scope → markdown last handed to the store
const rulesWatchers = new Map(); // watched dir → FSWatcher
let rulesWatchTimer = null;

function rulesFileOf(scope) {
  return scope === 'global' ? globalRulesFile : path.join(scope, PROJECT_RULES_FILE);
}

function readRulesFile(scope) {
  try {
    return fs.readFileSync(rulesFileOf(scope), 'utf8');
  } catch {
    return null;
  }
}

// The same root the guard computes: worktrees share their main checkout's rules.
async function rulesRootOf(cwd) {
  if (rulesRootCache.has(cwd)) return rulesRootCache.get(cwd);
  let root = null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 2000 });
    const common = stdout.trim();
    root = common.endsWith(`${path.sep}.git`) ? path.dirname(common) : common || null;
  } catch {
    // not a repo
  }
  rulesRootCache.set(cwd, root);
  return root;
}

function syncRulesScope(scope) {
  const markdown = readRulesFile(scope);
  if (markdown === null && scope !== 'global' && !rulesStore.snapshot().repos[scope]) return;
  if (rulesSynced.get(scope) === markdown) return;
  rulesSynced.set(scope, markdown);
  if (scope !== 'global' && markdown !== null) rulesStore.markSeenRepo(scope);
  rulesStore.syncFile(scope, scope === 'global' ? (markdown ?? '') : markdown);
}

// Spec §5: a save, or an outside edit of a file already trusted, compiles
// the new lines on its own. A repo file that came with a clone waits for the
// user's first compile in the window.
const rulesCompiling = new Set();
const rulesCompileStatus = new Map(); // scope → error code of the last try

function trustedScope(scope) {
  return scope === 'global' || Boolean(rulesStore.snapshot().repos[scope]?.compiled);
}

async function autoCompile(scope, { force = false } = {}) {
  if (rulesCompiling.has(scope) || (!force && !trustedScope(scope))) return;
  const view = scope === 'global' ? rulesStore.snapshot().global : rulesStore.snapshot().repos[scope];
  const drafted = new Set((view?.drafts ?? []).map((draft) => draft.source));
  const fresh = (view?.pending ?? []).filter((line) => !drafted.has(line));
  const lines = fresh.length || !force ? fresh : (view?.pending ?? []);
  if (lines.length === 0) return;
  rulesCompiling.add(scope);
  rulesCompileStatus.delete(scope);
  notifyRulesChanged();
  try {
    const result = await compileRules({ lines, scope, budget: tokenBudget, budgetDaily: managerConfig.tokenBudgetDaily });
    if (result.error) rulesCompileStatus.set(scope, result.error);
    else rulesStore.setDrafts(scope, result.drafts);
  } catch (error) {
    log(`rules compile failed: ${error}`);
    rulesCompileStatus.set(scope, 'sem-claude');
  } finally {
    rulesCompiling.delete(scope);
    notifyRulesChanged();
  }
}

async function ruleScopeKeys() {
  const keys = new Set(['global']);
  for (const root of workspaceProjects()) {
    const repo = await rulesRootOf(root);
    if (repo) keys.add(repo);
  }
  for (const session of registry.list()) {
    if (!session.cwd) continue;
    const repo = await rulesRootOf(session.cwd);
    if (repo && readRulesFile(repo) !== null) keys.add(repo);
  }
  for (const repo of Object.keys(rulesStore.snapshot().repos)) keys.add(repo);
  return [...keys];
}

function watchRulesDirs(keys) {
  for (const scope of keys) {
    const dir = path.dirname(rulesFileOf(scope));
    if (rulesWatchers.has(dir) || !isDirectory(dir)) continue;
    try {
      const watcher = fs.watch(dir, (_type, name) => {
        if (name && name !== 'regras.md') return;
        clearTimeout(rulesWatchTimer);
        rulesWatchTimer = setTimeout(() => {
          for (const key of keys) syncRulesScope(key);
          syncGuardHook();
          notifyRulesChanged();
          for (const key of keys) autoCompile(key);
        }, 500);
      });
      watcher.on('error', () => rulesWatchers.delete(dir));
      rulesWatchers.set(dir, watcher);
    } catch (error) {
      log(`rules watch failed for ${dir}: ${error}`);
    }
  }
}

async function rulesState() {
  const keys = await ruleScopeKeys();
  for (const key of keys) syncRulesScope(key);
  watchRulesDirs(keys);
  const snapshot = rulesStore.snapshot();
  const scopes = keys.map((key) => {
    const view = key === 'global' ? snapshot.global : snapshot.repos[key] ?? { approved: [], drafts: [], pending: [], compiled: true };
    const markdown = readRulesFile(key);
    return {
      scope: key,
      label: key === 'global' ? 'global' : path.basename(key),
      file: rulesFileOf(key),
      markdown: markdown ?? '',
      approved: view.approved,
      drafts: view.drafts,
      pending: view.pending,
      // A project the user starts from the window is theirs; only a file that
      // arrived with the repo waits for a first compile.
      compiled: markdown === null || view.compiled,
      compiling: rulesCompiling.has(key),
      compileError: rulesCompileStatus.get(key) ?? null,
    };
  });
  return { status: guardStatus(), scopes, history: rulesStore.recentHistory(50) };
}

function notifyRulesChanged() {
  if (rulesWindow && !rulesWindow.isDestroyed()) rulesWindow.webContents.send('rules:changed');
  sendState();
}

// Opened from the tray menu, mutter's focus-stealing prevention leaves a new
// (or re-shown) window behind the others; a moment of always-on-top makes it
// come to the front, the same as a click on it would.
function bringRulesWindowForward() {
  if (!rulesWindow || rulesWindow.isDestroyed()) return;
  if (rulesWindow.isMinimized()) rulesWindow.restore();
  rulesWindow.show();
  rulesWindow.setAlwaysOnTop(true);
  rulesWindow.moveTop();
  rulesWindow.focus();
  setTimeout(() => {
    if (rulesWindow && !rulesWindow.isDestroyed()) rulesWindow.setAlwaysOnTop(false);
  }, 300);
}

function openRulesWindow() {
  if (rulesWindow && !rulesWindow.isDestroyed()) {
    bringRulesWindowForward();
    return;
  }
  rulesWindow = new BrowserWindow({
    width: 860,
    height: 780,
    minWidth: 560,
    minHeight: 480,
    title: 'Vizor — regras',
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(rendererDir, 'rules-preload.cjs'), contextIsolation: true },
  });
  rulesWindow.removeMenu();
  rulesWindow.on('close', (event) => {
    if (appQuitting) return;
    event.preventDefault();
    rulesWindow.hide();
  });
  rulesWindow.once('ready-to-show', bringRulesWindowForward);
  rulesWindow.loadFile(path.join(rendererDir, 'rules.html'));
}

const fromRules = (event) => Boolean(rulesWindow && !rulesWindow.isDestroyed() && event.sender === rulesWindow.webContents);

function writeRulesFile(scope, markdown) {
  const file = rulesFileOf(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, markdown);
  fs.renameSync(`${file}.tmp`, file);
}

function validScope(scope) {
  return scope === 'global' || (typeof scope === 'string' && path.isAbsolute(scope) && isDirectory(scope));
}

ipcMain.on('rules:open', () => openRulesWindow());

ipcMain.handle('rules:state', (event) => (fromRules(event) ? rulesState() : null));

ipcMain.handle('rules:save', async (event, { scope, markdown } = {}) => {
  if (!fromRules(event) || !validScope(scope) || typeof markdown !== 'string') return rulesState();
  writeRulesFile(scope, markdown);
  // Saved from the window: the user's own text, so it is never shown as "de
  // fora" while the first compile runs (or when it fails), and it compiles
  // right away.
  if (scope !== 'global') rulesStore.markOwnedRepo(scope);
  syncRulesScope(scope);
  syncGuardHook();
  autoCompile(scope, { force: true });
  return rulesState();
});

ipcMain.handle('rules:compile', async (event, { scope } = {}) => {
  if (!fromRules(event) || !validScope(scope)) return { error: 'origem inválida' };
  syncRulesScope(scope);
  const view = scope === 'global' ? rulesStore.snapshot().global : rulesStore.snapshot().repos[scope];
  const pending = view?.pending ?? [];
  const drafted = new Set((view?.drafts ?? []).map((draft) => draft.source));
  const fresh = pending.filter((line) => !drafted.has(line));
  const lines = fresh.length ? fresh : pending;
  if (lines.length === 0) return { state: await rulesState(), compiled: 0 };
  const result = await compileRules({ lines, scope, budget: tokenBudget, budgetDaily: managerConfig.tokenBudgetDaily });
  if (result.error) return { error: result.error };
  rulesStore.setDrafts(scope, result.drafts);
  sendState();
  return { state: await rulesState(), compiled: result.drafts.length };
});

ipcMain.handle('rules:approve', async (event, { scope, ruleId, edited = null } = {}) => {
  if (!fromRules(event) || !validScope(scope)) return rulesState();
  let clean = null;
  if (edited) {
    const view = scope === 'global' ? rulesStore.snapshot().global : rulesStore.snapshot().repos[scope];
    const draft = view?.drafts.find((candidate) => candidate.id === ruleId);
    clean = draft ? validateEditedRule(draft, edited) : null;
    // A risky regex says why, instead of the generic message.
    if (!clean) return { ...(await rulesState()), error: 'edicao-invalida', reason: editProblem(edited) ?? undefined };
  }
  rulesStore.approve(scope, ruleId, clean);
  syncGuardHook();
  notifyRulesChanged();
  return rulesState();
});

ipcMain.handle('rules:discard', async (event, { scope, ruleId } = {}) => {
  if (!fromRules(event) || !validScope(scope)) return rulesState();
  rulesStore.discard(scope, ruleId);
  notifyRulesChanged();
  return rulesState();
});

ipcMain.handle('rules:test', (event, { scope, command } = {}) => {
  if (!fromRules(event) || !validScope(scope) || typeof command !== 'string') return null;
  const snapshot = rulesStore.snapshot();
  const rules = [...snapshot.global.approved, ...(scope === 'global' ? [] : (snapshot.repos[scope]?.approved ?? []))];
  const hit = evaluate({ rules, call: { tool: 'Bash', input: { command } }, git: scope === 'global' ? null : gitContextOf(scope) });
  return hit ? { kind: hit.rule.kind, source: hit.rule.source, explain: hit.rule.explain } : null;
});

// Also flipped from the settings window, hence no sender check.
ipcMain.handle('rules:set-enabled', async (event, enabled) => {
  managerConfig = { ...managerConfig, guardEnabled: Boolean(enabled) };
  saveConfig(configFile, managerConfig);
  syncGuardHook();
  notifyRulesChanged();
  return fromRules(event) ? rulesState() : guardStatus();
});

let rulesRefreshTimer = null;
function refreshRuleWatches() {
  clearTimeout(rulesRefreshTimer);
  rulesRefreshTimer = setTimeout(async () => {
    try {
      const keys = await ruleScopeKeys();
      for (const key of keys) syncRulesScope(key);
      watchRulesDirs(keys);
      syncGuardHook();
    } catch (error) {
      log(`rules refresh failed: ${error}`);
    }
  }, 2000);
}

function bootSyncRules() {
  for (const scope of ['global', ...Object.keys(rulesStore.snapshot().repos)]) {
    try {
      syncRulesScope(scope);
    } catch (error) {
      log(`rules sync failed for ${scope}: ${error}`);
    }
  }
  pruneSeenSessions({
    dir: path.join(rulesDir, 'sessoes'),
    now: Date.now(),
    readdir: (dir) => fs.readdirSync(dir),
    stat: (file) => fs.statSync(file),
    unlink: (file) => fs.unlinkSync(file),
  });
}

// --- Voice (#161) -------------------------------------------------------------
// Linux only in v1. The engine runs in a worker thread; a hidden window owns
// the microphone; nothing is recorded.

function voiceAvailable() {
  return process.platform === 'linux';
}

function onVoiceUtterance(text) {
  log(`voice: "${text}"`);
  voiceSession?.onUtterance(text).catch((error) => {
    log(`voice failed: ${error?.stack ?? error}`);
    voiceArbiter?.say({ text: spokenLang() === 'en' ? 'Something went wrong here; check the log.' : 'Deu erro aqui; olha o log.', priority: 1 });
  });
}

// --- Voice session (#161): what an utterance does --------------------------
const voiceDir = path.join(configDir, 'voz');
const vocabularyStore = createVocabularyStore({
  dir: path.join(voiceDir, 'vocabulario'),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  writeFile: (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  },
  rename: (from, to) => fs.renameSync(from, to),
});
// Routines (#163), per project; without one open, a shared list.
const routinesStore = createRoutines({
  file: path.join(voiceDir, 'rotinas.json'),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  writeFile: (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  },
  rename: (from, to) => fs.renameSync(from, to),
});
const routinesHere = () => voiceRoot() ?? '*';

const taskLinks = createTaskLinks({
  file: path.join(voiceDir, 'tasks.json'),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  writeFile: (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  },
  rename: (from, to) => fs.renameSync(from, to),
});
const VOCABULARY_MAX_AGE_MS = 24 * 3600 * 1000;
const voiceScanning = new Set();
const voiceInfoCache = new Map(); // sessionId → { title, lastMessage, cwd }
const pendingNewChats = new Map(); // pty id → resolve({ sessionId })
let lastGhDigest = null;

const runText = async (command, args, options = {}) => (await execFileAsync(command, args, { maxBuffer: 1e7, timeout: 15000, ...options })).stdout;

function voiceProject() {
  const focused = ptyHost?.list().find((terminal) => terminal.id === activeTerminalId)?.cwd ?? null;
  const target = voiceSession?.target();
  const boundCwd = target?.kind === 'chat' ? (registry.sessions.get(target.sessionId)?.cwd ?? voiceInfoCache.get(target.sessionId)?.cwd ?? null) : null;
  return resolveProject({ focusedCwd: focused, boundCwd, projects: workspaceProjects() });
}

function voiceRoot() {
  return voiceProject().root ?? workspaceProjects()[0] ?? null;
}

let vocabularySentFor = null; // `${root}:${scannedAt}:${learned}` last handed to the worker

// The voice worker corrects transcripts with the focused project's names.
function syncVoiceVocabulary({ force = false } = {}) {
  const root = voiceRoot();
  if (!voiceListener || !root) return;
  refreshVocabulary(root);
  const data = vocabularyStore.load(root);
  const signature = `${root}:${data.scannedAt}:${data.learned.length}`;
  if (!force && signature === vocabularySentFor) return;
  vocabularySentFor = signature;
  voiceListener.setVocabulary(data.terms, data.learned);
}

function refreshVocabulary(root) {
  if (!root || voiceScanning.has(root)) return;
  if (Date.now() - vocabularyStore.load(root).scannedAt < VOCABULARY_MAX_AGE_MS) return;
  voiceScanning.add(root);
  scanVocabulary({ root, run: runText })
    .then(({ terms }) => {
      vocabularyStore.save(root, { terms, scannedAt: Date.now() });
      syncVoiceVocabulary();
    })
    .catch((error) => log(`vocabulary scan failed: ${error}`))
    .finally(() => voiceScanning.delete(root));
}

async function voiceGhDigest() {
  const root = voiceRoot();
  // Whatever is read now belongs to this root; until then, nothing does.
  lastGhResults = null;
  lastGhResultsRoot = root;
  const english = spokenLang() === 'en';
  if (!root) return { speech: english ? 'Open a project in the workspace first.' : 'Abra um projeto no workspace primeiro.', lines: [] };
  try {
    const remote = await runText('git', ['remote', 'get-url', 'origin'], { cwd: root }).catch(() => '');
    const repo = githubRepoOf(remote);
    if (!repo) return { speech: english ? "This project isn't on GitHub." : 'Esse projeto não está no GitHub.', lines: [] };
    let defaultBranch = 'main';
    try {
      defaultBranch = (await runText('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root })).trim().replace(/^[^/]+\//, '') || 'main';
    } catch {
      // no origin/HEAD: main
    }
    const results = {};
    await Promise.all(
      Object.entries(ghQueries(repo, defaultBranch)).map(async ([key, args]) => {
        results[key] = JSON.parse(await runText('gh', args, { cwd: root }));
      }),
    );
    lastGhDigest = buildDigest(results, spokenLang());
    lastGhContext = managerContext(results);
    lastGhResults = results;
    lastGhDigestAt = Date.now();
  } catch (error) {
    log(`gh digest failed: ${error}`);
    lastGhDigest = buildDigest({ error: String(error) }, spokenLang());
    lastGhContext = managerContext({ error: String(error) });
    lastGhResults = null;
  }
  return lastGhDigest;
}

async function voiceResolveTask(number, { byTitle = true } = {}) {
  const root = voiceRoot();
  if (!root) return { none: true };
  const worktrees = worktreeCache.get(root) ?? (await listWorktrees(root).catch(() => [])) ?? [];
  const folders = [...new Set([root, ...worktrees.map((tree) => tree.path)])];
  const conversations = [];
  for (const folder of folders) {
    for (const conversation of await listConversations(await resolveClaudeProjectDir(folder), { limit: 200 }))
      conversations.push({ ...conversation, cwd: folder });
  }
  const found = resolveTask({ number, links: taskLinks.linksFor(root, number), conversations, worktrees, byTitle });
  if (found.sessionId) {
    const snapshot = await readTranscriptSnapshot(claudeTranscriptPath(found.cwd, found.sessionId)).catch(() => null);
    const title = conversations.find((item) => item.sessionId === found.sessionId)?.title ?? null;
    voiceInfoCache.set(found.sessionId, { title, lastMessage: snapshot?.lastAssistantMessage ?? null, cwd: found.cwd });
  }
  return found;
}

function ptyOfSession(sessionId) {
  const session = registry.sessions.get(sessionId);
  if (session?.term?.VIZOR_PTY_ID && ptyHost?.list().some((terminal) => terminal.id === session.term.VIZOR_PTY_ID && terminal.alive))
    return session.term.VIZOR_PTY_ID;
  for (const [ptyId, resumed] of resumedChats) if (resumed === sessionId) return ptyId;
  return null;
}

async function voiceOpenOrFocus({ sessionId, cwd }) {
  workspaceWindow?.show();
  if (!ptyOfSession(sessionId)) {
    const live = readLiveSessionIds();
    if (live?.has(sessionId)) {
      // Running in another terminal: two processes on one history would be
      // worse than not opening it.
      const outside = registry.sessions.get(sessionId);
      if (outside) huntSessionTab(outside).catch?.((error) => log(`voice focus failed: ${error}`));
      return { sessionId };
    }
    const opened = openTerminal({ cwd, kind: 'resume', sessionId });
    if (opened.error) log(`voice resume failed: ${opened.error}`);
  }
  setTimeout(() => workspaceWindow?.focusSession(sessionId), 400);
  return { sessionId };
}

// The plan file stays out of git: `.vizor/` joins the repo's info/exclude.
async function excludePlanFile(cwd) {
  try {
    const file = path.resolve(cwd, (await runText('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd })).trim());
    const current = await fs.promises.readFile(file, 'utf8').catch(() => '');
    const next = excludeWithPlan(current);
    if (next === null) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, next);
  } catch (error) {
    log(`plan exclude failed: ${error}`);
  }
}

// task: the issue the chat is for, which names its tab (taskTitles, over the
// title the terminal sets itself).
async function voiceOpenNew({ cwd, prompt, task = null }) {
  workspaceWindow?.show();
  if (cwd) await excludePlanFile(cwd);
  const opened = openTerminal({ cwd, kind: 'claude', prompt });
  if (opened.error) return Promise.resolve({ sessionId: null });
  if (Number.isInteger(task)) {
    const issue = catalogFrom({ results: lastGhResults, resultsRoot: lastGhResultsRoot, root: voiceRoot() }).issues.find((item) => item.number === task);
    taskTitles.set(opened.id, taskTabTitle(task, issue?.title));
  }
  return new Promise((resolve) => {
    pendingNewChats.set(opened.id, resolve);
    setTimeout(() => {
      if (pendingNewChats.delete(opened.id)) resolve({ sessionId: null });
    }, 30000);
  });
}

// The same rule as the 💬 comments: type into the tab only between turns and
// only when its own claude is the job in front; otherwise wait for the turn.
const PROMPT_ENTER_DELAY_MS = 150;
async function voiceDeliverPrompt(sessionId, text) {
  if (!sessionId) return 'failed';
  const ptyId = ptyOfSession(sessionId);
  if (!ptyId) return 'failed';
  const session = registry.sessions.get(sessionId) ?? { id: sessionId, status: 'done' };
  if (!safeToTypeIdle(session, Date.now()) || !claudeInPty(session, ptyId)) return 'hold';
  ptyHost.write(ptyId, bracketedPaste(text));
  await new Promise((resolve) => setTimeout(resolve, PROMPT_ENTER_DELAY_MS));
  if (!claudeInPty(session, ptyId)) return 'failed';
  ptyHost.write(ptyId, '\r');
  return 'sent';
}

const GH_DIGEST_MAX_AGE_MS = 2 * 60 * 1000;
let lastGhDigestAt = 0;
let lastGhContext = null;
let lastGhResults = null; // the raw gh lists, for the Ctrl+K bar
let lastGhResultsRoot = null; // the project they were read for

// The gerente has no tools of its own: it gets the project's GitHub state
// with the question (live test: "não tenho acesso ao GitHub").
async function voiceAskManager(text) {
  if (!lastGhDigest || Date.now() - lastGhDigestAt > GH_DIGEST_MAX_AGE_MS) await voiceGhDigest();
  // Every open PR and issue, read by the Vizor with gh (#159: the gerente
  // reads, the músicos act).
  const github = lastGhContext ? `\n\n(GitHub do projeto agora — use pra responder:\n${lastGhContext})` : '';
  const { reply, tokensUsed } = await askManager({ sessions: listWithDisplayNames(), history: [], userMessage: `${text}${github}`, lang: spokenLang() });
  tokenBudget.add(tokensUsed);
  return reply;
}

// A spoken work order no command matched, often garbled ("pega eixo e um
// meia 9"): Haiku reads it against the open issues and says which one was
// meant. Only a number that is really open counts (live test).
async function voiceInterpret(text) {
  if (isEconomyMode()) return null;
  if (!lastGhContext || Date.now() - lastGhDigestAt > GH_DIGEST_MAX_AGE_MS) await voiceGhDigest();
  const open = new Set([...String(lastGhContext ?? '').matchAll(/^issue #(\d+)/gm)].map((match) => Number(match[1])));
  if (!open.size) return null;
  const result = await runClaude({
    prompt: [
      'Você interpreta um pedido falado em pt-BR, transcrito com erros (números e a palavra "issue" saem errados: "eixo e um meia 9" é "issue 169").',
      'Issues abertas do projeto:',
      String(lastGhContext).split('\n').filter((line) => line.startsWith('issue #')).join('\n'),
      `Pedido: "${text}"`,
      'Se o pedido é começar, pegar ou desenvolver UMA dessas issues, responda só {"action":"pick-issue","number":N}. Senão, responda só {"action":"none"}.',
    ].join('\n'),
    timeoutMs: 15000,
  });
  tokenBudget.add(result?.tokens ?? 0);
  const number = Number(String(result?.text ?? '').match(/"number"\s*:\s*(\d+)/)?.[1]);
  const picked = /"action"\s*:\s*"pick-issue"/.test(result?.text ?? '') && open.has(number);
  log(`voice interpret: "${text}" → ${picked ? `issue ${number}` : 'nothing'}`);
  return picked ? { type: 'pick-issue', number } : null;
}

async function voiceSummarize(plain) {
  if (isEconomyMode()) return null;
  const result = await runClaude({
    prompt:
      spokenLang() === 'en'
        ? `Summarize in at most two short sentences, in American English, to be spoken aloud, no markdown and no code. The text may be in Portuguese:\n\n${plain.slice(0, 4000)}`
        : `Resuma em no máximo duas frases curtas, em pt-BR, pra ser falado em voz alta, sem markdown e sem código:\n\n${plain.slice(0, 4000)}`,
    timeoutMs: 15000,
  });
  tokenBudget.add(result?.tokens ?? 0);
  return result?.text?.trim() || null;
}

function voiceAnswerGuard(choice) {
  const ask = guardAsks.pending().at(-1);
  if (!ask) return false;
  const request = guardAsks.answer(ask.id, choice);
  if (request) recordGuardOutcome({ ...request, summary: ask.summary }, GUARD_OUTCOMES[choice] ?? choice);
  return Boolean(request);
}

function voiceFindChat(query) {
  const wanted = String(query ?? '').toLowerCase();
  const number = Number(wanted);
  const root = voiceRoot();
  if (Number.isInteger(number) && number > 0 && root) {
    const linked = taskLinks.linksFor(root, number).find((id) => registry.sessions.has(id) || voiceInfoCache.has(id));
    if (linked) return linked;
  }
  const match = listWithDisplayNames().find((session) =>
    [session.displayName, session.title, session.promptPreview, session.cwd && path.basename(session.cwd)]
      .filter(Boolean)
      .some((name) => String(name).toLowerCase().includes(wanted)),
  );
  return match?.id ?? null;
}

function voiceSessionInfo(sessionId) {
  const session = registry.sessions.get(sessionId);
  const cached = voiceInfoCache.get(sessionId) ?? {};
  return {
    title: session?.title ?? cached.title ?? (session ? displayNameOf(session) : null),
    lastMessage: session?.lastMessage ?? cached.lastMessage ?? null,
    cwd: session?.cwd ?? cached.cwd ?? null,
  };
}

function createVoiceSessionForApp() {
  return createVoiceSession({
    say: (item) => voiceArbiter?.say(item),
    flushSpeech: () => voiceArbiter?.flush(),
    // Corrected in the voice worker already (heavy on a big repo); here
    // only a project switch is noticed so the worker gets its names.
    correct: (text) => {
      syncVoiceVocabulary();
      return { text };
    },
    ghDigest: voiceGhDigest,
    showLines: (lines) => {
      if (!lines.length) return;
      sendToRenderer('tooltip', { projectName: 'GitHub', text: lines.slice(0, 8).join(' · '), kind: 'hint', sessionId: null });
      showTooltip();
    },
    resolveTask: voiceResolveTask,
    openOrFocus: voiceOpenOrFocus,
    openNew: voiceOpenNew,
    linkTask: (number, sessionId) => {
      const root = voiceRoot();
      if (root && sessionId) taskLinks.link(root, number, sessionId);
    },
    sessionInfo: voiceSessionInfo,
    deliverPrompt: voiceDeliverPrompt,
    askManager: voiceAskManager,
    answerGuard: voiceAnswerGuard,
    workspace: (action, file) => {
      workspaceWindow?.show();
      workspaceWindow?.send('workspace:voice', { action, file: file ?? null });
    },
    summarize: voiceSummarize,
    economy: () => isEconomyMode(),
    learn: (pair) => {
      const root = voiceRoot();
      if (root) vocabularyStore.learn(root, pair);
      syncVoiceVocabulary({ force: true });
    },
    findChat: voiceFindChat,
    dictation: (on) => voiceListener?.dictation(on),
    keepListening: () => voiceListener?.wake(),
    projectRoot: () => voiceRoot(),
    settings: () => ({ narration: managerConfig.voiceNarration !== false, summary: managerConfig.voiceSummary ?? 'always' }),
    lang: spokenLang,
    maestro: maestroOn,
    setMaestro: (on) => applyConfig({ maestroEnabled: on }),
    orchestra: () => maestroOrchestra,
    focus: maestroFocus,
    interrupt: maestroInterrupt,
    pendingOrder: maestroOrder,
    routines: {
      save: (name, steps) => routinesStore.save(routinesHere(), name, steps),
      get: (name) => routinesStore.get(routinesHere(), name),
      list: () => routinesStore.list(routinesHere()),
      remove: (name) => routinesStore.remove(routinesHere(), name),
    },
    interpret: voiceInterpret,
    planAction: async (sessionId, action) => planAction(sessionId, action),
    focusedSession: () => (maestroOn() ? maestroFocusId : workspaceSelectedSession ?? null),
    conductor: maestroConductor,
    // Now only for a chat really at rest: no question, no permission ask on screen (review C1).
    startOrderNow: (sessionId) => {
      const session = registry.sessions.get(sessionId);
      if (!session || session.question || session.needsPermission) return;
      if (session.status === 'done' || session.status === 'waiting') runConductor(maestroConductor.turnEnded(sessionId, { tests: null }));
    },
    linkedSessions: (number) => {
      const root = voiceRoot();
      return root ? taskLinks.linksFor(root, number) : [];
    },
    onError: (error) => log(`maestro order failed: ${error?.stack ?? error}`),
  });
}

function voiceStatus() {
  const target = voiceSession?.target();
  const title = target?.kind === 'chat' ? voiceSessionInfo(target.sessionId).title : null;
  return {
    available: voiceAvailable(),
    enabled: Boolean(managerConfig.voiceEnabled),
    state: voiceState,
    model: managerConfig.voiceModel ?? 'parakeet',
    narration: managerConfig.voiceNarration !== false,
    summary: managerConfig.voiceSummary ?? 'always',
    mic: managerConfig.voiceMic ?? null,
    mics: micDevices,
    download: voiceDownload,
    target: target?.kind === 'chat' ? `chat ${title ? title.slice(0, 40) : ''}`.trim() : voiceListener ? 'gerente' : null,
  };
}

// Turned on: the models come down first (with progress), then it listens.
function enableVoice() {
  if (!voiceAvailable() || !managerConfig.voiceEnabled) return;
  const model = managerConfig.voiceModel ?? 'parakeet';
  if (!missingVoiceModels(voiceSherpaDir, model).length) {
    startVoice();
    return;
  }
  if (voiceDownload && !voiceDownload.error) return;
  const sizes = { kws: KWS_MODEL.approxMB, vad: VAD_MODEL.approxMB, [ASR_MODELS[model].id]: ASR_MODELS[model].approxMB };
  const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  const received = {};
  voiceDownload = { percent: 0 };
  sendState();
  let lastPush = 0;
  installVoiceModels(voiceSherpaDir, model, {
    onProgress: ({ id, received: bytes, total: size }) => {
      received[id] = size ? (bytes / size) * (sizes[id] ?? 0) : 0;
      voiceDownload = { percent: Math.min(99, Math.round((100 * Object.values(received).reduce((sum, mb) => sum + mb, 0)) / total)) };
      if (Date.now() - lastPush > 500) {
        lastPush = Date.now();
        sendState();
      }
    },
  })
    .then(() => {
      voiceDownload = null;
      log('voice: models installed');
      startVoice();
      sendState();
    })
    .catch((error) => {
      voiceDownload = { error: String(error?.message ?? error) };
      log(`voice models failed: ${error}`);
      sendState();
    });
}

// Another app recording the mic (a call) pauses listening (#161).
async function checkMeeting() {
  if (!voiceListener) return;
  try {
    const dump = parsePwDump(await runText('pw-dump', []));
    if (!dump) return; // a garbled dump is not a reason to stop watching
    const ours = new Set(app.getAppMetrics().map((metric) => metric.pid));
    const others = otherRecorders(dump, ours);
    const inMeeting = others.length > 0;
    if (inMeeting !== (voiceState === 'meeting')) {
      log(`voice: ${inMeeting ? `paused, ${others.join(', ')} is recording` : 'back from the meeting'}`);
      voiceListener.meeting(inMeeting);
    }
  } catch (error) {
    // no pw-dump: no meeting detection on this machine
    clearInterval(meetingTimer);
    meetingTimer = null;
    log(`voice: meeting detection off (${error?.message ?? error})`);
  }
}

ipcMain.handle('voice:vocabulary', () => {
  const root = voiceRoot();
  if (!root) return { root: null, terms: 0, learned: [] };
  const data = vocabularyStore.load(root);
  return { root, project: path.basename(root), terms: data.terms.length, learned: data.learned, scanning: voiceScanning.has(root) };
});
ipcMain.handle('voice:unlearn', (_event, heard) => {
  const root = voiceRoot();
  if (root && typeof heard === 'string') vocabularyStore.unlearn(root, heard);
  syncVoiceVocabulary({ force: true });
  return true;
});
ipcMain.handle('voice:rescan', () => {
  const root = voiceRoot();
  if (!root) return false;
  vocabularyStore.save(root, { terms: vocabularyStore.load(root).terms, scannedAt: 0 });
  refreshVocabulary(root);
  return true;
});

function createMicWindow() {
  micWindow = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: { preload: path.join(rendererDir, 'mic-preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  });
  micWindow.webContents.once('did-finish-load', () =>
    micWindow?.webContents.send('mic:control', { command: 'start', mic: managerConfig.voiceMic ?? null }),
  );
  micWindow.loadFile(path.join(rendererDir, 'mic.html'));
}

function startVoice() {
  if (voiceListener || !voiceAvailable() || !managerConfig.voiceEnabled) return;
  const model = managerConfig.voiceModel ?? 'parakeet';
  const missing = missingVoiceModels(voiceSherpaDir, model);
  if (missing.length) {
    voiceState = 'sem-modelos';
    log(`voice: models missing (${missing.join(', ')})`);
    enableVoice();
    return;
  }
  const worker = new Worker(new URL('./voice/worker.js', import.meta.url), {
    workerData: { paths: voiceModelPaths(voiceSherpaDir, model) },
  });
  worker.on('error', (error) => log(`voice worker failed: ${error}`));
  // A dead engine must not leave the voice "listening" and deaf: restart it,
  // a few times, waiting longer each time.
  worker.on('exit', (code) => {
    if (!voiceListener || appQuitting) return;
    log(`voice worker exited (${code})`);
    stopVoice();
    voiceRestarts += 1;
    if (voiceRestarts > 3) {
      voiceState = 'erro';
      sendState();
      return;
    }
    setTimeout(() => {
      if (managerConfig.voiceEnabled) startVoice();
    }, 2000 * voiceRestarts);
  });
  worker.on('message', (message) => {
    if (message?.type === 'error') log(`voice: ${message.error}`);
    if (message?.type === 'ready') log('voice: engine ready');
  });
  voiceListener = createListener({ worker });
  voiceArbiter = createSpeechArbiter({
    lang: spokenLang,
    speak: (text, item) =>
      new Promise((resolve) => {
        // The balloon: the gerente's and the voice's own lines. A músico's
        // answer shows as its real message on Stop, its narration in the
        // consequences strip; the "ok" and "só um momento" are not news.
        const fromMusician = maestroOrchestra.some((musician) => musician.sessionId === item.source);
        if (!fromMusician && !item.replaceKey && item.kind !== 'ack' && item.kind !== 'filler') maestroSay('manager', text);
        // The short "ok" does not pause listening, but its own echo must not
        // count as the user talking: ignored until it played, plus a margin.
        if (item.kind === 'ack') voiceListener?.ignoreSpeech(30000);
        else voiceListener?.speakingStarted();
        const volume = Math.round((managerConfig.voiceVolume * managerConfig.soundVolume) / 100);
        tts.speak(text, {
          voice: managerConfig.voice,
          volume,
          onDone: () => {
            if (item.kind === 'ack') voiceListener?.ignoreSpeech(300);
            resolve();
          },
        });
      }),
    stop: () => tts.stopSpeaking(),
  });
  voiceArbiter.on('quiet', ({ followUp } = {}) => voiceListener?.speakingEnded({ followUp }));
  voiceListener.on('state', (state) => {
    voiceState = state;
    // The user is finishing a sentence (maybe "cancela"): the order waits.
    if (state === 'closing' || state === 'grace') maestroOrder.pause();
    else maestroOrder.resume();
    // Held through the grace window too: a line starting there would pause
    // listening and lose the utterance (only the "ok" passes).
    voiceArbiter?.userSpeaking(state === 'listening' || state === 'closing' || state === 'grace');
    sendState();
  });
  voiceListener.on('echo', ({ text }) => {
    sendToRenderer('tooltip', { projectName: 'você disse', text, kind: 'hint', sessionId: null });
    showTooltip();
  });
  // A beep, not a spoken "ok" (live test: the word every time was tiring);
  // its echo is not the user talking.
  voiceListener.on('ack', () => {
    sendToRenderer('chime', { kind: 'beep' });
    voiceListener?.ignoreSpeech(500);
  });
  voiceListener.on('error', (error) => log(`voice engine: ${error}`));
  voiceListener.on('barge', () => voiceArbiter?.flush());
  voiceListener.on('cancelled', (payload) => {
    if (payload?.stopSpeaking) voiceArbiter?.flush();
    // "não, espera" / "para" never reach the session: the listener takes
    // them. A held order goes with them (review I2).
    if (maestroOrder.pending()) {
      maestroOrder.cancel();
      voiceArbiter?.say({ text: spokenLang() === 'en' ? 'Cancelled.' : 'Cancelado.', priority: 1 });
    }
  });
  voiceListener.on('utterance', ({ text }) => {
    voiceRestarts = 0; // the engine works again
    voiceArbiter?.noteUserTurn();
    onVoiceUtterance(text);
  });
  voiceSession = createVoiceSessionForApp();
  vocabularySentFor = null;
  syncVoiceVocabulary();
  voiceState = 'sleeping';
  createMicWindow();
  meetingTimer = setInterval(checkMeeting, 3000);
}

function stopVoice() {
  clearInterval(meetingTimer);
  meetingTimer = null;
  voiceSession = null;
  voiceArbiter?.flush();
  voiceArbiter = null;
  voiceListener?.close();
  voiceListener = null;
  if (micWindow && !micWindow.isDestroyed()) micWindow.destroy();
  micWindow = null;
  voiceState = 'off';
}

const fromMic = (event) => Boolean(micWindow && !micWindow.isDestroyed() && event.sender === micWindow.webContents);
ipcMain.on('mic:chunk', (event, samples) => {
  if (fromMic(event)) voiceListener?.feed(samples);
});
ipcMain.on('mic:devices', (event, found) => {
  if (!fromMic(event)) return;
  chromiumOutputs = normalizeMicList(found?.outputs);
  const next = normalizeMicList(found?.mics);
  if (JSON.stringify(next) !== JSON.stringify(micDevices)) log(`mic devices: ${next.map((mic) => mic.label).join(' | ') || 'none'}`);
  micDevices = next;
  sendState();
  refreshTrayMenu();
});
ipcMain.on('mic:status', (event, status) => {
  if (fromMic(event)) log(`mic: ${status}`);
});

// The microphone is the mic window's alone; every other permission keeps
// Electron's default.
function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(permission !== 'media' || webContents === micWindow?.webContents),
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    permission !== 'media' || webContents === micWindow?.webContents,
  );
}

// crossSessionInbound decides what a session does with the quick reply this app
// sends. It lives in the user's Claude Code settings, so the app only ever
// writes the user level — a repo or managed setting can still tighten it, and
// the panel says so instead of promising an outcome.
ipcMain.handle('inbound:get', () => readInboundPolicy(readClaudeSettings()));

ipcMain.handle('inbound:set', (_event, value) => {
  const settings = readClaudeSettings();
  if (!settings) return readInboundPolicy(null);
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
  speakAsManager(updateDonePhrase(spokenLang()));
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
  adoptResumedChats();
  const liveIds = readLiveSessionIds();
  if (!appQuitting) {
    trackChatEnds({ watched: chatsInTabs(), liveIds, seen: chatsSeenAlive, ended: chatsEnded });
    // A resumed chat that ended no longer stands for its tab (review I-2).
    for (const [ptyId, sessionId] of resumedChats) if (chatsEnded.has(sessionId)) resumedChats.delete(ptyId);
    scheduleTabsSave();
  }
  const before = [...registry.sessions.keys()];
  registry.reconcileLiveSessions(liveIds);
  for (const sessionId of before)
    if (!registry.sessions.has(sessionId)) {
      editTracker.forgetSession(sessionId);
      commentStore.forgetSession(sessionId);
      guardAsks.dropSession(sessionId);
      voiceSession?.onSessionEnded(sessionId);
    }
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
  bootSyncRules();
  syncGuardHook();
  autoSetupBridgeOnWayland();
  hydrateRegistry();
  reapDeadSessions();
  createWindows();
  socketServer = startSocketServer(socketPath, onHookEvent, log);
  setupMediaPermissions();
  startVoice();
  setupTray();
  if (process.platform === 'linux') {
    refreshAudioOutputs();
    setInterval(refreshAudioOutputs, 10000);
  }
  registry.on('change', sendState);
  registry.on('change', scheduleCommandRoots);
  registry.on('change', flushHeldComments);
  registry.on('change', forgetRemovedSessions);
  registry.on('change', updateNotificationHalo);
  registry.on('change', scheduleSessionsSave);
  registry.on('change', refreshRuleWatches);
  refreshRuleWatches();
  registry.on('change', scheduleTabsSave);
  restoreWorkspaceTabs();
  setInterval(() => registry.prune(), PRUNE_INTERVAL_MS);
  setInterval(reapDeadSessions, LIVENESS_INTERVAL_MS);
  updaterHandle = setupUpdater({ onStatus: onUpdateStatus, log, beforeExit: freezeWorkspaceTabs });
  applyShortcuts();
});

app.on('will-quit', () => {
  quitFreeze.willQuit();
  globalShortcut.unregisterAll();
  ptyHost?.killAll();
  commandWatcher.stopAll();
});

app.on('window-all-closed', () => {
  // with a tray icon the app lives on with every window hidden
  if (!tray) app.quit();
});

// Quitting kills the workspace terminals (they live in this process), so a
// quit the USER asks for through our UI confirms first when one is alive. Only
// UI paths ask: a logout, shutdown or SIGTERM also reaches before-quit (Electron
// turns SIGTERM into a quit before any JS signal listener runs), and a dialog
// there would hold the whole session hostage.
let quitAsking = false;
async function requestQuit() {
  if (quitAsking) return; // a second click while the dialog is up (#118)
  const prompt = quitPrompt(ptyHost?.aliveCount() ?? 0);
  if (prompt) {
    quitAsking = true;
    try {
      const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Encerrar o Vizor', ...prompt });
      if (response !== 0) return;
    } finally {
      quitAsking = false;
    }
  }
  app.quit();
}

// The review state saves 500 ms after a click: a quit inside that window
// would lose an approval, so the first quit waits for the writes and asks again.
let reviewSaved = false;
app.on('before-quit', (event) => {
  if (!reviewSaved) {
    reviewSaved = true;
    event.preventDefault();
    // A stalled disk must not hold a logout or SIGTERM hostage: give up after 1.5 s.
    const saves = Promise.allSettled([...reviewStores.values()].map((entry) => Promise.resolve().then(() => entry.flush())))
      .then((results) => {
        for (const result of results) if (result.status === 'rejected') log(`review state flush on quit failed: ${result.reason}`);
      });
    Promise.race([saves, new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() => app.quit());
    return;
  }
  appQuitting = true;
  // Before will-quit kills the terminals: their chats are still alive here.
  // A quit cancelled after this point thaws the saves again (#157).
  quitFreeze.beforeQuit();
  // closing for real means the hooks stop firing too — parking in the tray is
  // not closing, so they stay while the app watches from there
  removeHooksInstalled();
  removeGuardIfOnlineOnly();
  stopVoice();
  // A question still on screen would end in a deny when the socket closes;
  // "offline" sends it to the terminal's own permission prompt instead.
  guardAsks.releaseAll('offline');
  tts.stopSpeaking();
  killPendingClaude();
  // verify.js runs detached process groups: they would outlive the app.
  for (const root of reviewRoots) reviewVerifier.cancelAll(root);
  stopSocketServer(socketServer, socketPath);
  tray?.destroy();
  tray = null;
});
