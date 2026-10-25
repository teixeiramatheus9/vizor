import path from 'node:path';

// Which runtime runs the rule guard. It must exist while the Vizor is closed:
// the deb/rpm binary does, but an AppImage's mount vanishes with the app, so
// there only a node on PATH keeps the guard alive offline. `offline: false`
// means the guard is removed on quit, and the rules screen says so.
export function guardCommand({ platform, execPath, appImage, findNode, scriptPath, shimDir }) {
  if (platform === 'win32') {
    const shimPath = path.win32.join(shimDir, 'rule-guard.cmd');
    const content = ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `"${execPath}" "${scriptPath}" %*`, ''].join('\r\n');
    return { command: `"${shimPath}"`, offline: false, shim: { path: shimPath, content } };
  }
  if (appImage) {
    const node = findNode();
    if (node) return { command: `"${node}" "${scriptPath}"`, offline: true };
    return { command: `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${scriptPath}"`, offline: false };
  }
  return { command: `ELECTRON_RUN_AS_NODE=1 "${execPath}" "${scriptPath}"`, offline: true };
}
