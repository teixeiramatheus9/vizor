// CJS on purpose: Electron preload scripts require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rules', {
  state: () => ipcRenderer.invoke('rules:state'),
  save: (scope, markdown) => ipcRenderer.invoke('rules:save', { scope, markdown }),
  compile: (scope) => ipcRenderer.invoke('rules:compile', { scope }),
  approve: (scope, ruleId, edited = null) => ipcRenderer.invoke('rules:approve', { scope, ruleId, edited }),
  discard: (scope, ruleId) => ipcRenderer.invoke('rules:discard', { scope, ruleId }),
  test: (scope, command) => ipcRenderer.invoke('rules:test', { scope, command }),
  setEnabled: (enabled) => ipcRenderer.invoke('rules:set-enabled', enabled),
  onChanged: (callback) => ipcRenderer.on('rules:changed', () => callback()),
});
