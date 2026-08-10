'use strict';

/*
 * Just Fits: makes a file small enough to send.
 *
 * This file is only wiring. The arithmetic is in plan.js and the ffmpeg work
 * is in engine.cjs, both of which run without Electron so they can be tested
 * directly.
 *
 * Two rules hold throughout: the original file is only ever read, and the app
 * never touches the network.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const engine = require('./engine.cjs');
const plan = require('./plan.js');
const binaries = require('./binaries.cjs');

let win = null;
let ctl = null;
let licenceWindow = null;

/* --- the bundled binaries --------------------------------------------- */

function vendorDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(__dirname, '..', 'vendor', 'ffmpeg');
}

// The app must never fall back to a system ffmpeg: someone who downloaded a
// finished app should not discover it needs a video encoder installing. The
// command line is the opposite and does fall back, which is why the two share
// a resolver with a flag rather than each having their own.
function binary(name) {
  return binaries.resolve(name, [vendorDir()], false);
}

/* --- wiring ------------------------------------------------------------ */

/*
 * Exported so test/window.test.cjs can register the same handlers against its
 * own window. Without that the test would be checking a renderer that has
 * nothing to talk to, and would miss a handler going missing here.
 */
function registerHandlers() {
  ipcMain.handle('targets', () => plan.TARGETS);

  ipcMain.handle('probe', async (_e, file) => {
    try {
      return { ok: true, info: await engine.probe(binary('ffprobe'), file) };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  });

  ipcMain.handle('fit', async (_e, { file, targetBytes }) => {
    ctl = engine.control();
    const onProgress = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('progress', p);
    };
    try {
      const info = await engine.probe(binary('ffprobe'), file);
      const args = { ffmpeg: binary('ffmpeg'), file, info, targetBytes, onProgress, ctl };
      const result = info.kind === 'image' ? await engine.fitImage(args) : await engine.fitVideo(args);
      return { ok: true, ...result, before: info.bytes, kind: info.kind };
    } catch (err) {
      if (err && err.cancelled) return { ok: false, cancelled: true };
      return { ok: false, message: String(err.message || err) };
    } finally {
      ctl = null;
    }
  });

  ipcMain.handle('cancel', () => {
    if (!ctl) return false;
    ctl.cancel();
    return true;
  });

  ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));

  // Opens in the real browser, never in an app window.
  ipcMain.handle('open-site', () => shell.openExternal('https://ponderdev.com'));

  // The GPL wants its notices readable by whoever has the app, not just by
  // whoever finds the repo, so they open in a window of their own.
  ipcMain.handle('open-licences', () => {
    if (licenceWindow && !licenceWindow.isDestroyed()) return licenceWindow.focus();
    licenceWindow = new BrowserWindow({
      width: 720,
      height: 680,
      title: 'Licences and credits',
      backgroundColor: '#12131a',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    licenceWindow.setMenuBarVisibility(false);
    licenceWindow.loadFile(path.join(__dirname, 'renderer', 'licenses.html'));
  });

  ipcMain.handle('pick-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{
        name: 'Video and images',
        extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'],
      }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 720,
      height: 780,
      minWidth: 560,
      minHeight: 640,
      backgroundColor: '#12131a',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  // Guarded so requiring this file from a test registers the handlers without
  // also opening a window.
  if (require.main === module) {
    registerHandlers();
    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => app.quit());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }

  module.exports = { registerHandlers, binary };
