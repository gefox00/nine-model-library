const { contextBridge, ipcRenderer } = require('electron');

// This renderer only receives its assigned model and returns one thumbnail.
// It has no access to the main window's library-management API.
contextBridge.exposeInMainWorld('nineThumbnail', Object.freeze({
  getInput: () => ipcRenderer.invoke('nine-thumb:input'),
  complete: result => ipcRenderer.invoke('nine-thumb:complete', result),
  fail: message => ipcRenderer.invoke('nine-thumb:fail', String(message)),
}));
