const { contextBridge, ipcRenderer } = require('electron');

// This renderer only receives its assigned job and returns a thumbnail for it.
// It has no access to the main window's library-management API.
contextBridge.exposeInMainWorld('nineThumbnail', Object.freeze({
  onJob: callback => {
    const listener = (_event, jobId) => callback(jobId);
    ipcRenderer.on('nine-thumb:job', listener);
    return () => ipcRenderer.removeListener('nine-thumb:job', listener);
  },
  ready: () => ipcRenderer.invoke('nine-thumb:ready'),
  getInput: jobId => ipcRenderer.invoke('nine-thumb:input', jobId),
  complete: (jobId, result) => ipcRenderer.invoke('nine-thumb:complete', jobId, result),
  fail: (jobId, message, discard) => ipcRenderer.invoke('nine-thumb:fail', jobId, String(message), discard),
}));
