'use strict';

/*
 * Finding ffmpeg and ffprobe.
 *
 * The desktop app carries its own copies, because someone downloading a free
 * app should not then have to install a video encoder. The command line does
 * not: anyone using a terminal on Linux either has ffmpeg or can install it
 * with one command, and a 300MB npm package to avoid that would be rude.
 *
 * So: the bundled copy if there is one, otherwise whatever is on PATH.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

// What kind of program a file is, from its first bytes: 'linux' (ELF),
// 'darwin' (Mach-O, thin or universal) or 'win32' (a DOS/PE stub). null for a
// script or anything else.
function kindOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    const hex = head.toString('hex');
    if (hex === '7f454c46') return 'linux';
    if (['cffaedfe', 'cefaedfe', 'feedface', 'feedfacf', 'cafebabe', 'bebafeca'].includes(hex)) return 'darwin';
    if (head.toString('latin1', 0, 2) === 'MZ') return 'win32';
  } catch { /* unreadable, so not usable */ }
  return null;
}

function fromDir(dir, name, platform = process.platform, arch = process.arch) {
  if (!dir) return null;
  const exe = platform === 'win32' ? '.exe' : '';
  // The platform-and-arch name says what it is. The older names (an arch alone,
  // or none) do not, and linux and mac both call themselves x64, so one of
  // them is taken only if its own bytes say it is a program for this platform.
  const exact = path.join(dir, `${name}-${platform}-${arch}${exe}`);
  if (fs.existsSync(exact)) return exact;
  for (const candidate of [`${name}-${arch}${exe}`, `${name}${exe}`]) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full) && kindOf(full) === platform) return full;
  }
  return null;
}

// Walks PATH ourselves. Minimal Linux images (Fedora minimal, slim Docker
// bases) often have no `which`, and its absence used to read as "ffmpeg not
// found" to someone who had ffmpeg installed.
function scanPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name + EXE);
    try {
      if (fs.statSync(full).isFile()) {
        if (process.platform !== 'win32') fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch {}
  }
  return null;
}

function fromPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(finder, [name + EXE], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n')[0].trim();
    return found || scanPath(name);
  } catch (err) {
    return scanPath(name);
  }
}

/**
 * @param name    'ffmpeg' or 'ffprobe'
 * @param dirs    vendor directories to try first, in order
 * @param allowPath  false for the packaged app, which must not depend on the
 *                   machine having its own ffmpeg
 */
function resolve(name, dirs = [], allowPath = true) {
  for (const dir of dirs) {
    const hit = fromDir(dir, name);
    if (hit) return hit;
  }
  if (allowPath) {
    const hit = fromPath(name);
    if (hit) return hit;
  }
  const where = allowPath ? 'bundled or on PATH' : 'bundled';
  throw new Error(
    `${name} not found (${where}).\n` +
    (allowPath
      ? `Install it with your package manager, for example:\n` +
        `  arch    sudo pacman -S ffmpeg\n` +
        `  debian  sudo apt install ffmpeg\n` +
        `  mac     brew install ffmpeg`
      : 'Run: npm run fetch-ffmpeg'),
  );
}

module.exports = { resolve, fromDir, fromPath, kindOf };
