'use strict';

// The only surface the page gets. No node, no filesystem, no network.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fits', {
  // Fetched from main rather than required in here: preloads are sandboxed
  // and can only require Electron's own modules. Keeping the sandbox is worth
  // more than the convenience, and it means one copy of the list either way.
  targets: () => ipcRenderer.invoke('targets'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  fit: (file, targetBytes) => ipcRenderer.invoke('fit', { file, targetBytes }),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  openSite: () => ipcRenderer.invoke('open-site'),
  openLicences: () => ipcRenderer.invoke('open-licences'),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  // File.path was removed in Electron 32. Dropped files have to be resolved
  // through webUtils now, which only exists on this side of the bridge.
  pathFor: (file) => webUtils.getPathForFile(file),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
});
