import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_VOICE, VOICES } from './sherpa-installer.js';
import { DEFAULT_THEME, DEFAULT_PALETTE, migrateThemeConfig } from './themes.js';
import { PANEL_SCALE } from './panel-size.js';
import { DEFAULT_SHORTCUTS } from './shortcuts.js';

export const DEFAULT_CONFIG = {
  terminal: 'auto',
  voice: DEFAULT_VOICE,
  theme: DEFAULT_THEME,
  palette: DEFAULT_PALETTE,
  crt: false,
  density: 'comfortable', // workspace density: 'comfortable' | 'compact'
  panelScale: PANEL_SCALE.default,
  muted: false,
  soundVolume: 70,
  voiceVolume: 100,
  timbre: 'marimba',
  ttsEnabled: false,
  typeVolumes: { start: 100, done: 100, question: 100, waiting: 100 },
  tokenBudgetDaily: 100000,
  automationDayCapUsd: 5, // the automações' own daily cap, in US$
  shortcuts: { ...DEFAULT_SHORTCUTS },
  autoUpdate: true,
  bridgeAutoSetupDone: false,
  announceWhenFocusUnknown: true,
  folderAliases: {},
  workspaceProjects: [],
  workspaceDismissed: [],
  guardEnabled: true,
  voiceEnabled: false,
  voiceModel: 'parakeet',
  voiceNarration: true,
  voiceSummary: 'always',
  voiceMic: null, // { id, label } pinned in the settings, or null for the system default
  audioOutput: null, // { name, label } a PipeWire sink pinned in the tray menu, or null
  maestroEnabled: false, // the Maestro stage in the workspace (#159)
  limits: { fiveHour: true, sevenDay: true, warnAt: 80, resetNotice: false, showInStatusBar: true },
};

// The usage-limits settings: unknown keys drop, wrong types fall back to the
// default, and the warning threshold stays within 50-95 %.
export function clampLimits(value, base = DEFAULT_CONFIG.limits) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = { ...base };
  for (const key of ['fiveHour', 'sevenDay', 'resetNotice', 'showInStatusBar']) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  if (Number.isFinite(src.warnAt)) out.warnAt = Math.min(95, Math.max(50, Math.round(src.warnAt)));
  return out;
}

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

export function loadConfig(file) {
  try {
    const config = migrateThemeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
    // Hand-edited lists must not break the workspace (#105).
    config.workspaceProjects = stringList(config.workspaceProjects);
    config.workspaceDismissed = stringList(config.workspaceDismissed);
    if (!(config.automationDayCapUsd >= 0.5 && config.automationDayCapUsd <= 100)) config.automationDayCapUsd = DEFAULT_CONFIG.automationDayCapUsd;
    config.limits = clampLimits(config.limits);
    if (!['comfortable', 'compact'].includes(config.density)) config.density = 'comfortable';
    // A voice that was dropped (Faber, #161) must not stick in the settings.
    if (!VOICES[config.voice]) config.voice = DEFAULT_VOICE;
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
