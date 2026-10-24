import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_VOICE } from './sherpa-installer.js';
import { DEFAULT_THEME, DEFAULT_PALETTE, migrateThemeConfig } from './themes.js';
import { PANEL_SCALE } from './panel-size.js';
import { DEFAULT_SHORTCUTS } from './shortcuts.js';

export const DEFAULT_CONFIG = {
  terminal: 'auto',
  voice: DEFAULT_VOICE,
  theme: DEFAULT_THEME,
  palette: DEFAULT_PALETTE,
  crt: false,
  panelScale: PANEL_SCALE.default,
  muted: false,
  soundVolume: 70,
  voiceVolume: 100,
  timbre: 'marimba',
  ttsEnabled: false,
  typeVolumes: { start: 100, done: 100, question: 100, waiting: 100 },
  tokenBudgetDaily: 100000,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  autoUpdate: true,
  bridgeAutoSetupDone: false,
  announceWhenFocusUnknown: true,
  folderAliases: {},
  workspaceProjects: [],
  workspaceDismissed: [],
};

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

export function loadConfig(file) {
  try {
    const config = migrateThemeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) });
    // Hand-edited lists must not break the workspace (#105).
    config.workspaceProjects = stringList(config.workspaceProjects);
    config.workspaceDismissed = stringList(config.workspaceDismissed);
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
