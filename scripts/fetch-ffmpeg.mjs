/*
 * Puts ffmpeg and ffprobe into vendor/ffmpeg.
 *
 *   node scripts/fetch-ffmpeg.mjs            just this machine's arch
 *   node scripts/fetch-ffmpeg.mjs --all      everything a release needs
 *   node scripts/fetch-ffmpeg.mjs --mac      (or --win, --linux) one platform's builds
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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { wanted: wantedBuilds, unzipCommand } = createRequire(import.meta.url)('./fetch-lib.cjs');

// The hosts are small third parties and now and then refuse or stall a
// connection from a CI runner. Every download is checked by sha256 or by the
// licence gate afterwards, so trying again is safe. --fail makes an error page
// count as a failure, so it is retried instead of saved as the archive.
const RETRY = ['--fail', '--retry', '5', '--retry-delay', '20', '--retry-all-errors', '--connect-timeout', '30'];

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

// Windows and Linux both come from BtbN's GPL builds, pinned to one dated
// release and checked by the sha256 GitHub publishes for each archive, so a
// build made today and one made next month ship the same ffmpeg. ("latest"
// moved under us once: a newer ffprobe put a phone photo's turn somewhere the
// old code did not look.) BtbN prunes old dated releases now and then; when
// this one goes, the download fails loudly, and the fix is to pick a newer
// release, check it, and put its names and hashes here.
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-21-12-37/';
const WIN_ZIP = {
  url: BTBN + 'ffmpeg-N-129166-gae9f4540cb-win64-gpl.zip',
  sha256: '4f7e54b17b37ee7d8c539129efb839291929f27998f00f812828aeed1be9ce14',
};
const LINUX = {
  x64: {
    url: BTBN + 'ffmpeg-N-129166-gae9f4540cb-linux64-gpl.tar.xz',
    sha256: '1492ec42dac9391baf1b3f7e3e3acdbb2b80f0af4efc45945ff9b988f62120c8',
  },
  arm64: {
    url: BTBN + 'ffmpeg-N-129166-gae9f4540cb-linuxarm64-gpl.tar.xz',
    sha256: '2c13f66dda3d42ab994148332a2fb189823afd7b5ed10018bdba5f387db7f108',
  },
};

// An archive is installed only when it is the one pinned above.
function checkArchive(file, want, what) {
  const got = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== want) {
    throw new Error(
      `${what} archive checksum mismatch.\n  expected ${want}\n  got      ${got}\n` +
      'Refusing to install it.',
    );
  }
}

const wanted = wantedBuilds(process.argv, process.platform, process.arch);

fs.mkdirSync(vendor, { recursive: true });

function unzip(zip, dir) {
  const [cmd, args] = unzipCommand(process.platform, zip, dir);
  sh(cmd, args);
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

async function macTool(tool, arch) {
  const target = path.join(vendor, `${tool}-darwin-${arch}`);
  if (fs.existsSync(target)) return console.log(`  have ${tool}-darwin-${arch}`);

  if (arch === 'arm64') {
    const { url, sha256 } = MAC_ARM[tool];
    const tmp = path.join(os.tmpdir(), `${tool}-arm-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    console.log(`  fetching ${tool} for mac arm64`);
    sh('curl', [...RETRY, '-sL', '--max-time', '900', '-o', path.join(tmp, 'a.zip'), url]);
    unzip(path.join(tmp, 'a.zip'), tmp);

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

  const info = JSON.parse(sh('curl', [...RETRY, '-sL', '--max-time', '60', MAC_INFO(tool)]));
  const url = info.download.zip.url;
  const tmp = path.join(os.tmpdir(), `${tool}-${Date.now()}.zip`);
  console.log(`  fetching ${tool} ${info.version} for mac ${arch}`);
  sh('curl', [...RETRY, '-sL', '--max-time', '600', '-o', tmp, url]);
  unzip(tmp, vendor);
  fs.renameSync(path.join(vendor, tool), target);
  fs.chmodSync(target, 0o755);
  fs.unlinkSync(tmp);
}

async function windows() {
  const need = ['ffmpeg', 'ffprobe'].filter((t) => !fs.existsSync(path.join(vendor, `${t}-win32-x64.exe`)));
  if (!need.length) return console.log('  have both windows binaries');

  const tmp = path.join(os.tmpdir(), `ffmpeg-win-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  console.log('  fetching ffmpeg and ffprobe for windows x64 (~200MB)');
  sh('curl', [...RETRY, '-sL', '--max-time', '900', '-o', path.join(tmp, 'w.zip'), WIN_ZIP.url]);
  checkArchive(path.join(tmp, 'w.zip'), WIN_ZIP.sha256, 'windows');
  unzip(path.join(tmp, 'w.zip'), tmp);

  for (const tool of need) {
    // The zip nests everything under a versioned folder, so go and find it.
    const found = findFile(tmp, `${tool}.exe`);
    if (!found) throw new Error(`${tool}.exe was not in the windows archive`);
    fs.copyFileSync(found, path.join(vendor, `${tool}-win32-x64.exe`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function linux(arch) {
  const need = ['ffmpeg', 'ffprobe'].filter((t) => !fs.existsSync(path.join(vendor, `${t}-linux-${arch}`)));
  if (!need.length) return console.log(`  have both linux ${arch} binaries`);
  const pin = LINUX[arch];
  if (!pin) return console.log(`  no linux build published for ${arch}`);

  const tmp = path.join(os.tmpdir(), `ffmpeg-linux-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  console.log(`  fetching ffmpeg and ffprobe for linux ${arch} (~150MB)`);
  sh('curl', [...RETRY, '-sL', '--max-time', '900', '-o', path.join(tmp, 'f.tar.xz'), pin.url]);
  checkArchive(path.join(tmp, 'f.tar.xz'), pin.sha256, `linux ${arch}`);
  sh('tar', ['xf', path.join(tmp, 'f.tar.xz'), '-C', tmp]);

  for (const tool of need) {
    const found = findFile(tmp, tool);
    if (!found) throw new Error(`${tool} was not in the linux archive`);
    const target = path.join(vendor, `${tool}-linux-${arch}`);
    fs.copyFileSync(found, target);
    fs.chmodSync(target, 0o755);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  linux ${arch} done`);
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
  } else if (platform === 'linux') {
    await linux(arch);
  } else {
    console.log('  no automatic source for this platform, install ffmpeg yourself');
  }
}

console.log('\nvendor/ffmpeg now holds:');
for (const f of fs.readdirSync(vendor)) {
  console.log(' ', f, (fs.statSync(path.join(vendor, f)).size / 1e6).toFixed(0) + 'MB');
}
