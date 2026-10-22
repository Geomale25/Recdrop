const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  renameFile: (filePath, name) => ipcRenderer.invoke('file:rename', { filePath, name }),
  trashFile: (filePath) => ipcRenderer.invoke('file:trash', filePath),
  copyFile: (filePath) => ipcRenderer.invoke('file:copy', filePath),
  startDrag: (filePath) => ipcRenderer.send('file:startDrag', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('file:showInFolder', filePath),
});
