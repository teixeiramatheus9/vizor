// CJS on purpose: Electron preload scripts require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vizor', {
  onState: (callback) => ipcRenderer.on('workspace:state', (_event, state) => callback(state)),
  addProject: () => ipcRenderer.invoke('workspace:add-project'),
  removeProject: (root) => ipcRenderer.send('workspace:remove-project', root),
  openTerminal: (cwd, startClaude) => ipcRenderer.invoke('pty:open', { cwd, startClaude }),
  writeTerminal: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  closeTerminal: (id) => ipcRenderer.send('pty:close', id),
  terminalBuffer: (id) => ipcRenderer.invoke('pty:buffer', id),
  onTerminalData: (callback) => ipcRenderer.on('pty:data', (_event, payload) => callback(payload)),
  onTerminalExit: (callback) => ipcRenderer.on('pty:exit', (_event, payload) => callback(payload)),
  focusOutside: (sessionId) => ipcRenderer.invoke('warp:focus', sessionId),
});
