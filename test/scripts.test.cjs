'use strict';
// The build and contributor scripts: what a local build does that the release
// workflow does by hand, and the parts of the ffmpeg fetch that differ by
// platform.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lib = require('../scripts/fetch-lib.cjs');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) {
    console.error(`FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

test('every local dist script builds the icon and fetches its ffmpeg, as the release does', () => {
  for (const name of ['dist:mac', 'dist:win', 'dist:linux', 'dist']) {
    const cmd = pkg.scripts[name];
    assert(cmd, `${name} exists`);
    assert(/fetch-ffmpeg\.mjs --(mac|win|linux|all)/.test(cmd), `${name} fetches ffmpeg`);
    assert(/icon(:svg && npm run icon:raster)?\b/.test(cmd) && /npm run icon/.test(cmd), `${name} builds the icon`);
    assert(/npm run licences/.test(cmd), `${name} regenerates the licences`);
  }
  // Windows and Linux pack the png, so the raster must come before the build.
  // Linux makes it through icon:ensure (only when it is missing), because a CI
  // runner has no display for it there and makes it in its own step first.
  for (const name of ['dist:win', 'dist:linux']) {
    const at = Math.max(cmd(name).indexOf('icon:raster'), cmd(name).indexOf('icon:ensure'));
    assert(at > -1 && at < cmd(name).indexOf('electron-builder'), name);
  }
  assert(/icon:raster/.test(pkg.scripts['icon:png']) && /ensure-icon/.test(pkg.scripts['icon:ensure']), 'icon:ensure makes the raster');
  function cmd(n) { return pkg.scripts[n]; }
});

test('the ffmpeg fetch takes one platform, or this machine, or everything', () => {
  assert.deepStrictEqual(lib.wanted(['--mac'], 'linux', 'x64'), [['darwin', 'x64'], ['darwin', 'arm64']]);
  assert.deepStrictEqual(lib.wanted(['--win'], 'darwin', 'arm64'), [['win32', 'x64']]);
  assert.deepStrictEqual(lib.wanted(['--linux'], 'darwin', 'arm64'), [['linux', 'x64']]);
  assert.deepStrictEqual(lib.wanted([], 'darwin', 'arm64'), [['darwin', 'arm64']]);
  assert.strictEqual(lib.wanted(['--all'], 'win32', 'x64').length, 4);
});

test('a zip is unpacked with tar on Windows, which has no unzip, and unzip elsewhere', () => {
  assert.strictEqual(lib.unzipCommand('win32', 'a.zip', 'out')[0], 'tar');
  assert.strictEqual(lib.unzipCommand('darwin', 'a.zip', 'out')[0], 'unzip');
  assert.strictEqual(lib.unzipCommand('linux', 'a.zip', 'out')[0], 'unzip');
  const mjs = fs.readFileSync(path.join(root, 'scripts', 'fetch-ffmpeg.mjs'), 'utf8');
  assert(!/sh\('unzip'/.test(mjs), 'the fetch never calls unzip directly');
});

test('the release refuses an npm package without the skill or its linker', () => {
  const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert(yml.includes("grep -q 'agents/skills/justfits/SKILL.md' pack.txt"));
  assert(yml.includes("grep -q 'scripts/link-skill.cjs' pack.txt"));
});

test('an old-style ffmpeg name is used only if it is a program for this platform', () => {
  const os = require('os');
  const binaries = require('../src/binaries.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-'));
  try {
    const elf = Buffer.from('7f454c46', 'hex');
    fs.writeFileSync(path.join(dir, 'ffmpeg-x64'), Buffer.from('cffaedfe', 'hex'));
    assert.strictEqual(binaries.fromDir(dir, 'ffmpeg', 'linux', 'x64'), null, 'a mac binary is not a linux one');
    assert.strictEqual(binaries.fromDir(dir, 'ffmpeg', 'darwin', 'x64'), path.join(dir, 'ffmpeg-x64'));
    fs.writeFileSync(path.join(dir, 'ffmpeg'), elf);
    assert.strictEqual(binaries.fromDir(dir, 'ffmpeg', 'linux', 'x64'), path.join(dir, 'ffmpeg'));
    fs.writeFileSync(path.join(dir, 'ffmpeg-linux-x64'), 'named for its platform');
    assert.strictEqual(binaries.fromDir(dir, 'ffmpeg', 'linux', 'x64'), path.join(dir, 'ffmpeg-linux-x64'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the credits page shows the notices as a page, not as raw Markdown', () => {
  const { render } = require('../scripts/markdown.cjs');
  const html = render('## Title\n\n- one **bold** and `code`\n  more\n\n| a | b |\n| --- | --- |\n| [x](https://e.com) | <script> |\n\n```sh\nrun it\n```');
  assert(html.includes('<h3>Title</h3>') && html.includes('<strong>bold</strong>') && html.includes('<code>code</code>'));
  assert(html.includes('<table>') && html.includes('x (https://e.com)') && !html.includes('<a '), 'a link is text, never a link');
  assert(html.includes('&lt;script&gt;') && !html.includes('<script>'), 'escaped');
  const page = fs.readFileSync(path.join(root, 'src', 'renderer', 'licenses.html'), 'utf8');
  const notices = page.slice(page.indexOf('<div class="notices">'), page.indexOf('<h2>Full licence texts'));
  assert(notices.length > 500);
  assert(!/\*\*|^#+ |^\| ---|\]\(/m.test(notices), 'no Markdown marks left in the notices');
  assert(!/<pre class="notices">/.test(page));
});

console.log(`scripts: ${passed} passed`);
