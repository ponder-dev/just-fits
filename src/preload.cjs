'use strict';

// The only surface the page gets. No node, no filesystem, no network.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The tool's version, put on argv by main (a sandboxed preload cannot read
// package.json), for the start screen and the footer.
const version = (process.argv.find((a) => a.startsWith('--app-version=')) || '').slice('--app-version='.length);

contextBridge.exposeInMainWorld('fits', {
  version,
  // Fetched from main rather than required in here: preloads are sandboxed
  // and can only require Electron's own modules. Keeping the sandbox is worth
  // more than the convenience, and it means one copy of the list either way.
  targets: () => ipcRenderer.invoke('targets'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  fit: (file, targetBytes, options = {}) => ipcRenderer.invoke('fit', { file, targetBytes, beside: Boolean(options.beside), run: Number(options.run) || 0 }),
  cancel: () => ipcRenderer.invoke('cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  openSite: () => ipcRenderer.invoke('open-site'),
  openHowItWorks: () => ipcRenderer.invoke('open-how-it-works'),
  skillText: () => ipcRenderer.invoke('skill-text'),
  openLicences: () => ipcRenderer.invoke('open-licences'),
  // Several paths at once: files, or folders on a Mac.
  pickFile: () => ipcRenderer.invoke('pick-file'),
  // Folders alone, where the file picker cannot take them (Windows, Linux).
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  folderButton: process.platform !== 'darwin',
  platform: process.platform,
  gather: (paths) => ipcRenderer.invoke('gather', paths),
  // File.path was removed in Electron 32. Dropped files have to be resolved
  // through webUtils now, which only exists on this side of the bridge.
  pathFor: (file) => webUtils.getPathForFile(file),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
});
