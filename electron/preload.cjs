const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke(`nine:${method}`, ...args);

contextBridge.exposeInMainWorld('nine', {
  getState: () => invoke('getState'),
  addFiles: () => invoke('addFiles'),
  addFolder: () => invoke('addFolder'),
  removeFolder: id => invoke('removeFolder', id),
  rescan: () => invoke('rescan'),
  updateItem: (id, patch) => invoke('updateItem', id, patch),
  removeItem: id => invoke('removeItem', id),
  relinkModel: id => invoke('relinkModel', id),
  copyModel: id => invoke('copyModel', id),
  trashModel: id => invoke('trashModel', id),
  readModel: (id, options, requestId) => invoke('readModel', id, options, requestId),
  cancelModelRead: requestId => invoke('cancelModelRead', requestId),
  updateSettings: patch => invoke('updateSettings', patch),
  chooseOpenScad: () => invoke('chooseOpenScad'),
  getScadParameters: id => invoke('getScadParameters', id),
  listScadPresets: id => invoke('listScadPresets', id),
  saveScadPreset: (id, presetId, name, values) => invoke('saveScadPreset', id, presetId, name, values),
  applyScadPreset: (id, presetId) => invoke('applyScadPreset', id, presetId),
  removeScadPreset: (id, presetId) => invoke('removeScadPreset', id, presetId),
  exportScadPresets: id => invoke('exportScadPresets', id),
  importScadPresets: id => invoke('importScadPresets', id),
  renderScad: (id, values, requestId) => invoke('renderScad', id, values, requestId),
  cancelScadRender: requestId => invoke('cancelScadRender', requestId),
  exportScad: (id, options) => invoke('exportScad', id, options),
  cancelScadExport: () => invoke('cancelScadExport'),
  onScadExport: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('nine:scad-export', listener);
    return () => ipcRenderer.removeListener('nine:scad-export', listener);
  },
  saveThumbnail: (id, dataUrl, expectedSource) => invoke('saveThumbnail', id, dataUrl, expectedSource),
  startThumbnailBatch: (options = {}) => invoke('startThumbnailBatch', options),
  stopThumbnailBatch: () => invoke('stopThumbnailBatch'),
  getThumbnailBatch: () => invoke('getThumbnailBatch'),
  generateThumbnail: id => invoke('generateThumbnail', id),
  onThumbnailBatch: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('nine:thumbnail-batch', listener);
    return () => ipcRenderer.removeListener('nine:thumbnail-batch', listener);
  },
  openBambu: id => invoke('openBambu', id),
  getBambuPrintStatus: () => invoke('getBambuPrintStatus'),
  prepareBambuPrint: (id, values) => invoke('prepareBambuPrint', id, values),
  cancelBambuPrintPreparation: () => invoke('cancelBambuPrintPreparation'),
  revealItem: id => invoke('revealItem', id),
  chooseBambu: () => invoke('chooseBambu'),
  importPaths: paths => invoke('importPaths', paths),
  droppedPath: file => webUtils.getPathForFile(file),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('nine:state', listener);
    return () => ipcRenderer.removeListener('nine:state', listener);
  },
});
