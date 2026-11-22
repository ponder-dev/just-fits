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
// The frame: a dark title bar of the app's own on Windows and Linux, the traffic lights on a Mac.
const { frame, dress } = require('./kit/window.cjs');

const path = require('node:path');

// The tool's own version, from its package.json. Not app.getVersion(): run by
// a test or a harness, Electron reports its own version instead.
const APP_VERSION = (() => {
  try { return require(path.join(__dirname, '..', 'package.json')).version; } catch (e) { return app.getVersion(); }
})();
const fs = require('node:fs');

const engine = require('./engine.cjs');
const plan = require('./plan.js');
const binaries = require('./binaries.cjs');
const { scan, places } = require('./scan.cjs');

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
// The folder each gathered file came in with (null for a file on its own),
// and where the current run is putting results (scan.cjs places).
const gathered = new Map();
let placing = null;

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
      // Read fine but refused on purpose: its own sentence already names the file.
      if (err.code === 'animated-webp') return { ok: false, message: err.message };
      return { ok: false, message: probeMessage(file, String(err.message || err)) };
    }
  });

  // run: a number the window gives each press of Compress, so a folder's
  // results folder is chosen once per run ("Holiday (fitted)", then
  // "Holiday (fitted) 2" the next time). Which folder a file came in with is
  // main's own record from gather, never the page's word.
  ipcMain.handle('fit', async (_e, { file, targetBytes, beside, run }) => {
    ctl = engine.control();
    const onProgress = (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('progress', p);
    };
    let where = null;
    try {
      const info = await engine.probe(binary('ffprobe'), file);
      if (!placing || placing.run !== run || placing.beside !== Boolean(beside)) placing = { run, beside: Boolean(beside), place: places({ beside }) };
      where = placing.place({ path: path.resolve(file), from: gathered.get(path.resolve(file)) || null });
      if (where.outDir) await fs.promises.mkdir(where.outDir, { recursive: true });
      // Already small enough, in a folder's results folder: copied in under its
      // -fits name, so the results folder holds the whole folder (decided 2026-11-20).
      if (where.folder && info.bytes <= targetBytes) {
        const to = engine.outputPath(path.join(where.outDir, path.basename(file)), path.extname(file), fs.existsSync, where.suffix);
        await fs.promises.copyFile(file, to, fs.constants.COPYFILE_EXCL);
        return { ok: true, copied: true, path: to, bytes: info.bytes, before: info.bytes, kind: info.kind, folder: where.folder };
      }
      const args = { ffmpeg: binary('ffmpeg'), file, info, targetBytes, onProgress, ctl, outDir: where.outDir, suffix: where.suffix };
      const result = info.kind === 'image' ? await engine.fitImage(args) : await engine.fitVideo(args);
      return { ok: true, ...result, before: info.bytes, kind: info.kind, folder: where.folder, note: info.kind === 'video' ? plan.lengthNote(result.plan) : '' };
    } catch (err) {
      // Stopped or failed: a results folder made for this file and left empty
      // goes again, up to the results folder itself, so nothing empty is left.
      if (where && where.folder) {
        for (let dir = where.outDir; dir.startsWith(where.folder); dir = path.dirname(dir)) {
          try { await fs.promises.rmdir(dir); } catch { break; }
          if (dir === where.folder) break;
        }
      }
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

  // Opens in the real browser, never in an app window. The addresses are fixed
  // here; the page never hands main a URL to open.
  ipcMain.handle('open-site', () => shell.openExternal('https://ponderdev.com'));
  ipcMain.handle('open-how-it-works', () => shell.openExternal('https://ponderdev.com/tools/just-fits/how-it-works'));

  // The skill that ships with the app, for the start screen's Copy skill. Read
  // beside the app's own files, so it is the same text inside the packaged app
  // (electron-builder packs agents/) as from source.
  ipcMain.handle('skill-text', () => fs.promises.readFile(path.join(__dirname, '..', 'agents', 'skills', 'justfits', 'SKILL.md'), 'utf8'));

  // The GPL wants its notices readable by whoever has the app, not just by
  // whoever finds the repo, so they open in a window of their own.
  ipcMain.handle('open-licences', () => {
    if (licenceWindow && !licenceWindow.isDestroyed()) return licenceWindow.focus();
    licenceWindow = new BrowserWindow({
      width: 720,
      height: 680,
      title: 'Licences and credits',
      ...frame(),
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    dress(licenceWindow);
    licenceWindow.setMenuBarVisibility(false);
    licenceWindow.loadFile(path.join(__dirname, 'renderer', 'licenses.html'));
  });

  // Files and folders, several at once. Windows and Linux cannot offer files
  // and folders in one window (asked for both, they show a folder picker), so
  // there it picks files, and the start screen's Choose a folder (pick-folder)
  // brings a folder in.
  ipcMain.handle('pick-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: [{
        name: 'Video and images',
        extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'],
      }],
    });
    if (r.canceled || !r.filePaths.length) return [];
    lastOpenDir = path.dirname(r.filePaths[0]);
    return r.filePaths;
  });

  // Folders only, for Windows and Linux, where pick-file cannot offer them.
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      defaultPath: lastOpenDir || app.getPath('documents'),
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    lastOpenDir = r.filePaths[0];
    return r.filePaths;
  });

  // What several paths, or a folder, hold (scan.cjs). single: one path that is
  // not a folder, which the window takes the way it takes one file.
  ipcMain.handle('gather', async (_e, paths) => {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
    const found = await scan(list);
    for (const f of found.files) gathered.set(f.path, f.from);
    if (found.files[0]) lastOpenDir = path.dirname(found.files[0].path);
    return { ...found, single: list.length === 1 && found.folders === 0 };
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
      ...frame(),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
          // The version, from package.json, for the start screen and the footer.
          // A sandboxed preload cannot read package.json, so it comes on argv.
          additionalArguments: ['--app-version=' + APP_VERSION],
      },
    }));
    dress(win);
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
