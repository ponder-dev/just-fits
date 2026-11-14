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

const { app, BrowserWindow, screen, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const engine = require('./engine.cjs');
const plan = require('./plan.js');
const binaries = require('./binaries.cjs');

let win = null;
let ctl = null;
let licenceWindow = null;

// Windows starts an Open window in Downloads, which is usually empty and,
// filtered to video and images, shows nothing at all. So it starts where the
// last file came from instead, by dialog or by drop, else in Documents.
let lastOpenDir = null;

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
    let ffprobe;
    try {
      ffprobe = binary('ffprobe');
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
    try {
      const info = await engine.probe(ffprobe, file);
      lastOpenDir = path.dirname(file);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, message: probeMessage(file, String(err.message || err)) };
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
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: ['openFile'],
      filters: [{
        name: 'Video and images',
        extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'],
      }],
    });
    if (r.canceled) return null;
    lastOpenDir = path.dirname(r.filePaths[0]);
    return r.filePaths[0];
  });
  }

  // ffprobe's reason starts with the whole path ("C:\Users\...\clip.mp4:
  // Invalid data found when processing input"), which in the window is long,
  // technical and wraps across the error box. The window says it as a sentence
  // that names the file. The command line keeps ffprobe's words, for scripts.
  function probeMessage(file, reason) {
    const name = path.basename(String(file || ''));
    if (/no such file/i.test(reason)) return `Could not find ${name}. It may have been moved or deleted.`;
    if (/permission denied|operation not permitted/i.test(reason)) return `Just Fits is not allowed to open ${name}.`;
    return `${name} is not a video or picture that Just Fits can read.`;
  }


  // A laptop at 1366x768 has about 728 pixels of height left for a window once
  // the taskbar (or the menu bar and Dock) is taken off, and a window opened
  // taller than that put the bottom of the screen, the main button included,
  // out of reach under the taskbar. So the window, and its minimum, are fitted
  // to the work area of the screen it opens on.
  function fitToScreen(opts) {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const fit = { ...opts };
    for (const [key, side] of [['width', 'width'], ['height', 'height'], ['minWidth', 'width'], ['minHeight', 'height']]) {
      if (typeof fit[key] === 'number') fit[key] = Math.min(fit[key], area[side]);
    }
    return fit;
  }

  function createWindow() {
    win = new BrowserWindow(fitToScreen({
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
    }));
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  // Guarded so requiring this file from a test registers the handlers without
  // also opening a window. An env var rather than require.main, because under
  // `electron .` from source Electron does not make this file require.main, so
  // that check opened nothing.
  if (process.env.JUST_TEST_NO_WINDOW !== '1') {
    registerHandlers();
    app.whenReady().then(createWindow);
    app.on('window-all-closed', () => app.quit());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }

  module.exports = { registerHandlers, binary, probeMessage };
