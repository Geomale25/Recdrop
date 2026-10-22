const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  showInFolder: (filePath) => ipcRenderer.invoke('file:showInFolder', filePath),
});
