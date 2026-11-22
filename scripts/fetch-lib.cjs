'use strict';

/*
 * The decisions in fetch-ffmpeg.mjs that a test can reach: which builds a run
 * fetches, and what unpacks a zip on this machine.
 */

// --all is everything a release needs; --mac, --win and --linux are one
// platform's builds, for the matching dist script; with none, this machine's.
const ALL = [['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']];

function wanted(argv, platform, arch) {
  if (argv.includes('--all')) return ALL;
  const picked = [];
  if (argv.includes('--mac')) picked.push(...ALL.filter(([p]) => p === 'darwin'));
  if (argv.includes('--win')) picked.push(...ALL.filter(([p]) => p === 'win32'));
  if (argv.includes('--linux')) picked.push(...ALL.filter(([p]) => p === 'linux'));
  return picked.length ? picked : [[platform, arch]];
}

// Windows has no unzip, but since Windows 10 it has tar (bsdtar), which reads
// zips. Elsewhere unzip is the common one, and GNU tar cannot read a zip.
function unzipCommand(platform, zip, dir) {
  return platform === 'win32'
    ? ['tar', ['-xf', zip, '-C', dir]]
    : ['unzip', ['-oq', zip, '-d', dir]];
}

module.exports = { wanted, unzipCommand, ALL };
