import os from 'node:os';
import path from 'node:path';

export const configDir = path.join(os.homedir(), '.config', 'vizor');

// Windows has no unix sockets, so the IPC endpoint is a per-user named pipe
// there. Pipe names live in the pipe namespace, not on disk, and reject some
// characters — hence the username sanitization.
export function managerSocketPath(
  platform = process.platform,
  configDirectory = configDir,
  username = os.userInfo().username,
) {
  if (platform !== 'win32') return path.join(configDirectory, 'vizor.sock');
  const safe = String(username).replace(/[^A-Za-z0-9_-]/g, '-');
  return `\\\\.\\pipe\\vizor-${safe}`;
}

export const socketPath = managerSocketPath();
export const stateFile = path.join(configDir, 'state.json');
export const sessionsFile = path.join(configDir, 'sessions.json');
export const configFile = path.join(configDir, 'config.json');
export const usageFile = path.join(configDir, 'usage.json');
export const updateNoticeFile = path.join(configDir, 'update-notice.json');
export const logFile = path.join(configDir, 'log');
export const globalRulesFile = path.join(configDir, 'regras.md');
export const rulesDir = path.join(configDir, 'regras');
export const guardDir = path.join(configDir, 'guard');
// Per project: <repo root>/.vizor/regras.md
export const PROJECT_RULES_FILE = path.join('.vizor', 'regras.md');
