// CJS on purpose: Electron preload scripts require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mic', {
  chunk: (samples) => ipcRenderer.send('mic:chunk', samples),
  status: (status) => ipcRenderer.send('mic:status', String(status)),
  devices: (mics, outputs) => ipcRenderer.send('mic:devices', { mics, outputs }),
  onControl: (callback) => ipcRenderer.on('mic:control', (_event, command) => callback(command)),
});
