// CJS on purpose: Electron preload scripts require CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vizor', {
  onState: (callback) => ipcRenderer.on('workspace:state', (_event, state) => callback(state)),
  addProject: () => ipcRenderer.invoke('workspace:add-project'),
  removeProject: (root) => ipcRenderer.send('workspace:remove-project', root),
});
