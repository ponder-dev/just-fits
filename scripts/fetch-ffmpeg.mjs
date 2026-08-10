/*
 * Puts ffmpeg and ffprobe into vendor/ffmpeg.
 *
 *   node scripts/fetch-ffmpeg.mjs            just this machine's arch
 *   node scripts/fetch-ffmpeg.mjs --all      everything a release needs
 *
 * They are ~40-80MB each, they are not ours to redistribute through our own
 * git history, and they change on someone else's schedule. So vendor/ is
 * ignored and this fetches on demand.
 *
 * If a host ever moves, drop the binaries into vendor/ffmpeg by hand using
 * the names below. Nothing else in the app cares where they came from.
 *
 *   ffmpeg-x64   ffmpeg-arm64   ffprobe-x64   ffprobe-arm64
 *   ffmpeg-x64.exe   ffprobe-x64.exe
 *
 * Every build must be GPL enabled with libx264, or the app cannot encode.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', 'vendor', 'ffmpeg');

// evermeet publishes GPL mac builds and a JSON endpoint giving the current
// URL, so we ask rather than hardcode a version that will rot.
const MAC_INFO = (tool) => `https://evermeet.cx/ffmpeg/info/${tool}/release`;

// evermeet is x86_64 only. osxexperts publishes the Apple Silicon builds, with
// a SHA256 for each, so those are checked before anything is installed. Note
// the published hash is of the binary inside the zip, not of the zip.
const MAC_ARM = {
  ffmpeg: {
    url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
    sha256: '591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e',
  },
  ffprobe: {
    url: 'https://www.osxexperts.net/ffprobe9arm.zip',
    sha256: 'e11c17e8200b3ee4c4c186d245e2b4053f01d56957336c1817fca0b997469106',
  },
};

// BtbN publishes GPL win64 builds with a stable "latest" tag.
const WIN_ZIP =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const wanted = process.argv.includes('--all')
  ? [['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]
  : [[process.platform, process.arch]];

fs.mkdirSync(vendor, { recursive: true });

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

async function macTool(tool, arch) {
  const target = path.join(vendor, `${tool}-${arch}`);
  if (fs.existsSync(target)) return console.log(`  have ${tool}-${arch}`);

  if (arch === 'arm64') {
    const { url, sha256 } = MAC_ARM[tool];
    const tmp = path.join(os.tmpdir(), `${tool}-arm-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    console.log(`  fetching ${tool} for mac arm64`);
    sh('curl', ['-sL', '--max-time', '900', '-o', path.join(tmp, 'a.zip'), url]);
    sh('unzip', ['-oq', path.join(tmp, 'a.zip'), '-d', tmp]);

    const got = createHash('sha256').update(fs.readFileSync(path.join(tmp, tool))).digest('hex');
    if (got !== sha256) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(
        `${tool}-arm64 checksum mismatch.\n  expected ${sha256}\n  got      ${got}\n` +
        'Refusing to install it. Either the publisher rebuilt it, in which case update\n' +
        'the hash above after checking the site, or something is wrong.',
      );
    }

    fs.copyFileSync(path.join(tmp, tool), target);
    fs.chmodSync(target, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  ${tool}-arm64 checksum ok`);
    return;
  }

  const info = JSON.parse(sh('curl', ['-sL', '--max-time', '60', MAC_INFO(tool)]));
  const url = info.download.zip.url;
  const tmp = path.join(os.tmpdir(), `${tool}-${Date.now()}.zip`);
  console.log(`  fetching ${tool} ${info.version} for mac ${arch}`);
  sh('curl', ['-sL', '--max-time', '600', '-o', tmp, url]);
  sh('unzip', ['-oq', tmp, '-d', vendor]);
  fs.renameSync(path.join(vendor, tool), target);
  fs.chmodSync(target, 0o755);
  fs.unlinkSync(tmp);
}

async function windows() {
  const need = ['ffmpeg', 'ffprobe'].filter((t) => !fs.existsSync(path.join(vendor, `${t}-x64.exe`)));
  if (!need.length) return console.log('  have both windows binaries');

  const tmp = path.join(os.tmpdir(), `ffmpeg-win-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  console.log('  fetching ffmpeg and ffprobe for windows x64 (~80MB)');
  sh('curl', ['-sL', '--max-time', '900', '-o', path.join(tmp, 'w.zip'), WIN_ZIP]);
  sh('unzip', ['-oq', path.join(tmp, 'w.zip'), '-d', tmp]);

  for (const tool of need) {
    // The zip nests everything under a versioned folder, so go and find it.
    const found = findFile(tmp, `${tool}.exe`);
    if (!found) throw new Error(`${tool}.exe was not in the windows archive`);
    fs.copyFileSync(found, path.join(vendor, `${tool}-x64.exe`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

for (const [platform, arch] of wanted) {
  console.log(`${platform} ${arch}`);
  if (platform === 'darwin') {
    await macTool('ffmpeg', arch);
    await macTool('ffprobe', arch);
  } else if (platform === 'win32') {
    await windows();
  } else {
    console.log('  no automatic source for this platform, install ffmpeg yourself');
  }
}

console.log('\nvendor/ffmpeg now holds:');
for (const f of fs.readdirSync(vendor)) {
  console.log(' ', f, (fs.statSync(path.join(vendor, f)).size / 1e6).toFixed(0) + 'MB');
}
