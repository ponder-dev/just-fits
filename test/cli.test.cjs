'use strict';

/*
 * The command line, end to end.
 *
 *   node test/cli.test.cjs
 *
 * Runs the real binary as a subprocess, the way someone in a terminal would,
 * rather than calling into it. Needs ffmpeg either vendored or on PATH.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync, execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.cjs');
const binaries = require('../src/binaries.cjs');
const VENDOR = [path.join(__dirname, '..', 'vendor', 'ffmpeg')];

let FFMPEG;
try { FFMPEG = binaries.resolve('ffmpeg', VENDOR); } catch (e) { FFMPEG = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-cli-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

function makeClip(name, seconds = 8) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', '6000k', '-c:a', 'aac', '-pix_fmt', 'yuv420p', out]);
  return out;
}

// The first JSON line: the result, or the skip. A done line always follows it.
const first = (text) => JSON.parse(text.trim().split('\n')[0]);

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

test('--help lists the presets', () => {
  const out = run(['--help']);
  assert.match(out, /justfits <file>/);
  assert.match(out, /discord/);
  assert.match(out, /gmail/);
});

test('an unknown target is refused rather than guessed at', () => {
  assert.throws(() => run(['x.mp4', '--to', 'nonsense']), (e) =>
    /Unknown target/.test(e.stderr || ''));
});

test('a size can be given directly', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('size.mp4');
  const out = path.join(dir, 'size-out.mp4');
  const r = first(run([src, '--to', '2MB', '--out', out, '--json']));
  assert.equal(r.ok, true);
  assert.ok(r.after <= 2_000_000, `landed at ${r.after}`);
  assert.ok(fs.existsSync(out));
});

test('it writes beside the original and never over it', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('beside.mp4');
  const before = fs.readFileSync(src);
  run([src, '--to', '2MB', '--quiet']);
  assert.ok(fs.existsSync(path.join(dir, 'beside-fits.mp4')));
  assert.ok(before.equals(fs.readFileSync(src)), 'the original changed');
});

test('stdin in, stdout out, and stdout carries only the file', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('pipe.mp4');
  const out = path.join(dir, 'piped.mp4');
  // Piped through node rather than a shell, so it runs on Windows too: cat and
  // 2>/dev/null are POSIX only, and this test failed on the first Windows run.
  const r = spawnSync(process.execPath, [CLI, '--to', '2MB'], { input: fs.readFileSync(src), maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  fs.writeFileSync(out, r.stdout);
  const bytes = fs.statSync(out).size;
  assert.ok(bytes > 0 && bytes <= 2_000_000, `piped output was ${bytes} bytes`);
  // Not just any bytes: it has to be a real mp4
  const probe = execFileSync(binaries.resolve('ffprobe', VENDOR),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.ok(Number(probe.trim()) > 1, 'piped output is not a playable file');
});

test('a file that already fits is left alone', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('small.mp4', 2);
  const r = first(run([src, '--to', '500MB', '--json']));
  assert.equal(r.skipped, true);
});

test('-o never replaces an existing file, the input least of all', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('inplace.mp4', 2);
  const before = fs.readFileSync(src);
  assert.throws(() => run([src, '--to', '200KB', '-o', src]), (e) =>
    e.status === 2 && /Will not overwrite/.test(e.stderr || ''));
  assert.ok(before.equals(fs.readFileSync(src)), 'the original changed');
});

test('a missing option value is an error, not a silent default', () => {
  assert.throws(() => run(['x.mp4', '--to']), (e) => e.status === 2 && /needs a value/.test(e.stderr || ''));
  assert.throws(() => run(['x.mp4', '--to=']), (e) => e.status === 2 && /needs a value/.test(e.stderr || ''));
  assert.throws(() => run(['x.mp4', '-o', '--json']), (e) => e.status === 2 && /needs a value/.test(e.stderr || ''));
});

test('--json with the file on stdout puts the JSON on stderr', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('jsonpipe.mp4', 3);
  const out = path.join(dir, 'jsonpipe-out.mp4');
  const err = path.join(dir, 'jsonpipe.err');
  execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${JSON.stringify(src)} --to 500KB -o - --json > ${JSON.stringify(out)} 2> ${JSON.stringify(err)}`);
  assert.equal(first(fs.readFileSync(err, 'utf8')).path, '-');
  assert.ok(!fs.readFileSync(out).subarray(-200).toString('latin1').includes('"ok"'), 'JSON ended up in the video');
});

test('already fits with -o still leaves the file at -o', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const src = makeClip('fitsout.mp4', 2);
  const out = path.join(dir, 'fitsout-copy.mp4');
  const r = first(run([src, '--to', '500MB', '-o', out, '--json']));
  assert.equal(r.skipped, true);
  assert.equal(r.path, out);
  assert.ok(fs.readFileSync(src).equals(fs.readFileSync(out)));
});

test('-o into a missing folder names that folder, before any encoding', () => {
  if (!FFMPEG) return;
  const desk = fs.mkdtempSync(path.join(dir, 'nodir-'));
  const src = path.join(desk, 'notprobed.mp4');
  fs.writeFileSync(src, 'never read: the folder check comes first');
  const out = path.join('nodir', 'out.mp4');
  assert.throws(() => run([src, '-o', out], { cwd: desk }), (e) =>
    e.status === 2 && (e.stderr || '').trim() === `The folder nodir does not exist.`);
  assert.throws(() => run([src, '-o', path.join('notprobed.mp4', 'out.mp4')], { cwd: desk }), (e) =>
    e.status === 2 && (e.stderr || '').trim() === `notprobed.mp4 is not a folder.`);
  assert.ok(!fs.readdirSync(desk).some((f) => f.includes('-fits')), 'an encode started');
});

test('-o refuses Windows device names on every platform', () => {
  if (!FFMPEG) return;
  const src = path.join(dir, 'notprobed.mp4');
  fs.writeFileSync(src, 'never read: the name check comes first');
  for (const name of ['con.mp4', 'NUL', 'nul.zip', 'Aux.mp4', 'com1.mp4', 'LPT9.tar.gz', 'prn.mp4', 'nul. ', 'sub\\con.mp4']) {
    assert.throws(() => run([src, '-o', name], { cwd: dir }), (e) =>
      e.status === 2 && (e.stderr || '').trim() === `${name.split(/[\\/]/).pop()} is a name Windows keeps for a device, so nothing would be saved. Choose another name.`, name);
  }
  // Only the whole stem is reserved, not names that merely start with one.
  assert.throws(() => run([src, '-o', 'console.mp4'], { cwd: dir }), (e) =>
    !/keeps for a device/.test(e.stderr || ''));
});

test('a size in bytes is refused, not read as megabytes', () => {
  for (const to of ['8b', '8B', '12 b']) {
    assert.throws(() => run(['x.mp4', '--to', to]), (e) =>
      e.status === 2 && /is in bytes\. Did you mean \d+MB or \d+KB\?/.test(e.stderr || ''), to);
  }
  // The units that mean something still work.
  for (const to of ['8', '8mb', '8MB', '800kb', '1.5GB', '25 MB']) {
    assert.throws(() => run([path.join(dir, 'missing.mp4'), '--to', to]), (e) =>
      e.status === 2 && /No such file/.test(e.stderr || ''), to);
  }
});

test('an animated WebP is refused before anything is written', () => {
  // RIFF, size, WEBP, then a VP8X chunk whose flags byte has the animation bit.
  const head = Buffer.alloc(30);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(22, 4);
  head.write('WEBP', 8, 'latin1'); head.write('VP8X', 12, 'latin1');
  head.writeUInt32LE(10, 16); head[20] = 0x02;
  const src = path.join(dir, 'moving.webp');
  fs.writeFileSync(src, head);
  const r = spawnSync(process.execPath, [CLI, src, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(first(r.stdout).code, 'animated-webp');
  assert.match(r.stderr, /moving\.webp is an animated WebP/);
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('moving-fits')));
});

test('a picture will not be written as an MP4, nor a video as a JPEG', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const pic = path.join(dir, 'pic.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', pic]);
  assert.throws(() => run([pic, '--to', '1KB', '-o', path.join(dir, 'pic-out.mp4')]), (e) =>
    e.status === 2 && /is a picture, so it comes out as a JPEG/.test(e.stderr || ''));
  const clip = makeClip('kind.mp4', 2);
  assert.throws(() => run([clip, '--to', '1KB', '-o', path.join(dir, 'kind-out.jpg')]), (e) =>
    e.status === 2 && /is a video, so it comes out as an MP4/.test(e.stderr || ''));
  assert.ok(!fs.existsSync(path.join(dir, 'pic-out.mp4')) && !fs.existsSync(path.join(dir, 'kind-out.jpg')));
});

test('-o: an already-fitting PNG may be copied to a .png, a video is never named .mov, stdin is not called "input"', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const small = path.join(dir, 'small.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-frames:v', '1', small]);
  const copy = path.join(dir, 'copy.png');
  run([small, '-o', copy, '-q']);
  assert.ok(fs.existsSync(copy), 'a picture that already fits is copied to the name asked for');
  // Not fitting: a picture still comes out as a JPEG.
  const big = path.join(dir, 'bigger.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1600x1200', '-frames:v', '1', big]);
  assert.throws(() => run([big, '--to', '10KB', '-o', path.join(dir, 'bigger-out.png')]), (e) => e.status === 2 && /is a picture, so it comes out as a JPEG/.test(e.stderr || ''));
  const clip = makeClip('mov-name.mp4', 2);
  const mov = path.join(dir, 'named.mov');
  assert.throws(() => run([clip, '--to', '1KB', '-o', mov]), (e) => e.status === 2 && /comes out as an MP4/.test(e.stderr || ''));
  assert.ok(!fs.existsSync(mov), 'nothing was written under the .mov name');
  // Stdin has no name: the sentence says what arrived, not the temp file.
  const piped = spawnSync(process.execPath, [CLI, '-', '--to', '10KB', '-o', path.join(dir, 'stdin-out.png')], { input: fs.readFileSync(big), encoding: 'utf8' });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /What arrived on stdin is a picture/);
  assert.ok(!/\binput\b/.test(piped.stderr), piped.stderr);
});

test('a damaged picture is refused, not called "already fits"', () => {
  const broken = path.join(dir, 'broken.jpg');
  fs.writeFileSync(broken, 'not a picture');
  const r = spawnSync(process.execPath, [CLI, broken, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(first(r.stdout).code, 'not-media');
  assert.match(r.stderr, /broken\.jpg is not a video or picture/);
});

test('--describe names .heic and the notes field', () => {
  const d = JSON.parse(run(['--describe']));
  assert.ok(d.accepts.extensions.includes('.heic'));
  assert.ok('notes' in d.result.fields);
});

test('a target far too small for the length is said before encoding, and noted', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const clip = makeClip('long.mp4', 20);
  const r = spawnSync(process.execPath, [CLI, clip, '--to', '40KB', '--json'], { encoding: 'utf8' });
  const res = first(r.stdout);
  assert.ok(Array.isArray(res.notes) && /too long for/.test(res.notes[0]), JSON.stringify(res));
  const plain = spawnSync(process.execPath, [CLI, clip, '--to', '40KB', '-o', path.join(dir, 'long-2.mp4')], { encoding: 'utf8' });
  assert.match(plain.stderr.split('\n')[0], /too long for 40KB/);
});

/* --- several files and folders ------------------------------------------ */

const lines = (text) => text.trim().split('\n').map((l) => JSON.parse(l));
const picture = (file, size = '1600x1200') => {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', file]);
  return file;
};

test('several files are each fitted on their own, one JSON line each', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const a = makeClip('many-a.mp4', 2);
  const b = picture(path.join(dir, 'many-b.png'));
  const r = spawnSync(process.execPath, [CLI, a, b, '--to', '150KB', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r.stdout);
  assert.deepEqual(out.map((o) => o.type), ['result', 'result', 'done']);
  assert.deepEqual(out.slice(0, 2).map((o) => path.basename(o.input)), ['many-a.mp4', 'many-b.png']);
  for (const o of out.slice(0, 2)) {
    assert.equal(o.ok, true);
    assert.ok(o.after <= 150_000, `${o.input} landed at ${o.after}`);
    assert.ok(fs.existsSync(o.output) && path.dirname(o.output) === dir);
  }
  assert.equal(path.basename(out[1].output), 'many-b-fits.jpg');
  assert.deepEqual(out[2], { type: 'done', ok: true, results: 2, skipped: 0, failed: 0, exit: 0 });
});

test('a folder is fitted file by file into a new "folder (fitted)", subfolders too, passing over hidden files and earlier results', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const folder = path.join(dir, 'Trip');
  fs.mkdirSync(path.join(folder, 'day two'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.cache'));
  fs.copyFileSync(makeClip('trip-src.mp4', 2), path.join(folder, 'clip.mp4'));
  picture(path.join(folder, 'day two', 'still.png'));
  picture(path.join(folder, 'tiny.png'), '64x64');
  fs.writeFileSync(path.join(folder, 'broken.mp4'), 'not a video');
  fs.writeFileSync(path.join(folder, '._clip.mp4'), 'resource fork');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not media');
  fs.copyFileSync(path.join(folder, 'clip.mp4'), path.join(folder, '.cache', 'hidden.mp4'));
  fs.copyFileSync(path.join(folder, 'clip.mp4'), path.join(folder, 'old-fits.mp4'));

  const r = spawnSync(process.execPath, [CLI, folder, '--to', '150KB', '--json'], { encoding: 'utf8' });
  // Some done and one failed is exit 3, partly done.
  assert.equal(r.status, 3, r.stderr);
  const out = lines(r.stdout);
  const by = Object.fromEntries(out.filter((o) => o.input).map((o) => [path.relative(folder, o.input), o]));
  assert.deepEqual(Object.keys(by).sort(), ['broken.mp4', 'clip.mp4', path.join('day two', 'still.png'), 'tiny.png']);
  // A folder's results go into a new folder beside it, named for what was
  // done, subfolders mirrored, each named name-fits as it would be beside its original; the folder itself is untouched
  // (decided 2026-11-20).
  const results = folder + ' (fitted)';
  assert.equal(by['clip.mp4'].type, 'result');
  assert.equal(by['clip.mp4'].output, path.join(results, 'clip-fits.mp4'));
  assert.ok(fs.existsSync(path.join(results, 'clip-fits.mp4')));
  assert.equal(by[path.join('day two', 'still.png')].type, 'result');
  assert.ok(fs.existsSync(path.join(results, 'day two', 'still-fits.jpg')));
  // tiny.png already fits: copied in under its -fits name, so the folder is complete.
  assert.deepEqual(fs.readdirSync(results, { recursive: true }).sort(), ['clip-fits.mp4', 'day two', path.join('day two', 'still-fits.jpg'), 'tiny-fits.png']);
  assert.equal(by['tiny.png'].copied, true);
  assert.equal(by['tiny.png'].output, path.join(results, 'tiny-fits.png'));
  assert.equal(fs.readFileSync(path.join(results, 'tiny-fits.png')).equals(fs.readFileSync(path.join(folder, 'tiny.png'))), true);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['._clip.mp4', '.cache', 'broken.mp4', 'clip.mp4', 'day two', 'notes.txt', 'old-fits.mp4', 'tiny.png']);
  assert.equal(by['tiny.png'].type, 'skip');
  assert.equal(by['tiny.png'].reason, 'fits-already');
  assert.equal(by['broken.mp4'].type, 'error');
  assert.equal(by['broken.mp4'].code, 'not-media');
  assert.equal(by['broken.mp4'].message, 'broken.mp4 is not a video or picture that Just Fits can read.');
  assert.deepEqual(out[out.length - 1], { type: 'done', ok: false, results: 2, skipped: 1, failed: 1, exit: 3 });
  assert.ok(!fs.existsSync(path.join(folder, 'old-fits-fits.mp4')), 'an earlier result was fitted again');
  assert.match(spawnSync(process.execPath, [CLI, folder, '--to', '150KB'], { encoding: 'utf8' }).stderr, /Saved in .*Trip \(fitted\) 2$/m, 'a second run goes into a new folder');
  assert.ok(fs.existsSync(path.join(folder + ' (fitted) 2', 'clip-fits.mp4')));

  // The parent folder: the results folders beside Trip are not taken in again.
  const parent = spawnSync(process.execPath, [CLI, dir, '--to', '150KB', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.ok(!lines(parent.stdout).some((o) => o.input && o.input.includes('(fitted)')), 'a results folder was taken in again');
});

test('--beside saves a folder\'s results beside each original as name-fits, and makes no new folder', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const folder = path.join(fs.mkdtempSync(path.join(dir, 'beside-')), 'Shots');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  picture(path.join(folder, 'sub', 'big.png'));
  const r = spawnSync(process.execPath, [CLI, folder, '--to', '100KB', '--beside', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout)[0].output, path.join(folder, 'sub', 'big-fits.jpg'));
  assert.deepEqual(fs.readdirSync(path.dirname(folder)), ['Shots']);
});

test('several files: all failing is exit 1, and a person sees a line per file', () => {
  const a = path.join(dir, 'bad-a.mp4');
  const b = path.join(dir, 'bad-b.mov');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'y');
  const r = spawnSync(process.execPath, [CLI, a, b], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\[1\/2\] bad-a\.mp4: bad-a\.mp4 is not a video or picture/m);
  assert.match(r.stderr, /^\[2\/2\] bad-b\.mov: bad-b\.mov is not a video or picture/m);
  assert.match(r.stderr, /^2 files: 0 fitted, 2 failed\.$/m);
});

test('several files: -o, stdin, a missing path and an empty folder are usage errors, before any work', () => {
  const a = path.join(dir, 'u-a.mp4');
  const b = path.join(dir, 'u-b.mp4');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'y');
  const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
  fs.writeFileSync(path.join(empty, 'readme.txt'), 'nothing to fit');
  const cases = [
    [[a, b, '-o', path.join(dir, 'u-out.mp4')], /-o names one file/],
    [[a, '-'], /stdin \("-"\) is one file on its own/],
    [[a, path.join(dir, 'nope.mp4')], /No such file: .*nope\.mp4/],
    [[empty], /There are no videos or pictures in/],
  ];
  for (const [args, msg] of cases) {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 2, args.join(' '));
    const out = lines(r.stdout);
    assert.equal(out[0].code, 'usage');
    assert.match(out[0].message, msg);
  }
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('u-') && f.includes('-fits')));
});

test('--dry-run over a folder says what would happen to each file and writes nothing', { timeout: 300000 }, () => {
  if (!FFMPEG) return;
  const folder = fs.mkdtempSync(path.join(dir, 'dry-'));
  picture(path.join(folder, 'big.png'));
  picture(path.join(folder, 'small.png'), '64x64');
  const r = spawnSync(process.execPath, [CLI, folder, '--to', '100KB', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r.stdout);
  assert.deepEqual(out.slice(0, 2).map((o) => [path.basename(o.input), o.fits, path.relative(dir, o.output)]),
    [['big.png', false, path.join(path.basename(folder) + ' (fitted)', 'big-fits.jpg')], ['small.png', true, path.join(path.basename(folder) + ' (fitted)', 'small-fits.png')]]);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['big.png', 'small.png']);
  assert.ok(!fs.existsSync(folder + ' (fitted)'), 'a dry run made the results folder');
});

// A phone export mixes a photo, a Live Photo pair (the same name, a still and a
// short movie) and an .AAE sidecar (an edit list in a small plist). The sidecar
// is not a picture or a video, so the folder intake passes it over without a
// word: it is not a failure and not a skipped file. The Live Photo's movie is a
// video like any other and is fitted as one.
test('a phone folder: the .AAE sidecar is passed over, the Live Photo movie is fitted as a video', { timeout: 300000 }, async () => {
  const folder = path.join(fs.mkdtempSync(path.join(dir, 'phone-')), 'Camera');
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'phone-heic', 'portrait-arrow.heic'), path.join(folder, 'IMG_0001.HEIC'));
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4000k', '-pix_fmt', 'yuv420p', path.join(folder, 'IMG_0001.MOV')]);
  fs.writeFileSync(path.join(folder, 'IMG_0001.AAE'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>adjustmentFormatVersion</key><integer>1</integer></dict></plist>\n');

  // The intake, as the app and the command line both use it.
  const found = await require('../src/scan.cjs').scan([folder]);
  assert.deepEqual(found.files.map((f) => f.name).sort(), ['IMG_0001.HEIC', 'IMG_0001.MOV']);

  const r = spawnSync(process.execPath, [CLI, folder, '--to', '400KB', '--json'], { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r.stdout);
  const done = out.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.failed, 0, 'the sidecar was counted as a failure');
  assert.equal(done.results, 2);
  const results = out.filter((o) => o.type === 'result');
  assert.deepEqual(results.map((o) => path.basename(o.input)).sort(), ['IMG_0001.HEIC', 'IMG_0001.MOV']);
  assert.ok(!out.some((o) => /\.AAE$/i.test(o.input || '')), 'the sidecar was mentioned');
  const mov = results.find((o) => /\.MOV$/.test(o.input));
  assert.ok(mov.after <= 400 * 1000, `the movie landed at ${mov.after}`);
  assert.ok(mov.output.endsWith('.mp4') || mov.output.endsWith('.MOV') || mov.output.endsWith('.mov'), mov.output);
  const into = folder + ' (fitted)';
  assert.deepEqual(fs.readdirSync(into).sort(), results.map((o) => path.basename(o.output)).sort());
  assert.deepEqual(fs.readdirSync(folder).sort(), ['IMG_0001.AAE', 'IMG_0001.HEIC', 'IMG_0001.MOV']);
});

// Cancel part way through a folder, from the command line: Ctrl-C (SIGINT)
// stops the file being fitted with no half-written result, keeps the files
// already finished, and starts no more. The window's own version of this is
// 'Cancel stops a folder run at once' in test/window.test.cjs.
test('Cancel part way through a folder: the finished file is kept, the one being fitted leaves nothing, no more start', { skip: process.platform === 'win32' && 'no POSIX signals', timeout: 300000 }, async () => {
  const folder = path.join(fs.mkdtempSync(path.join(dir, 'cancel-')), 'Batch');
  fs.mkdirSync(folder);
  // a.png is quick and done first; the long video after it is still encoding
  // when the signal comes; c.png must never start.
  picture(path.join(folder, 'a.png'));
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4000k', '-pix_fmt', 'yuv420p', path.join(folder, 'b-long.mp4')]);
  picture(path.join(folder, 'c.png'));

  const child = require('node:child_process').spawn(process.execPath, [CLI, folder, '--to', '100KB', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let signalled = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!signalled && stdout.split('\n').slice(0, -1).map((l) => JSON.parse(l)).some((o) => o.type === 'result' && /a-fits/.test(o.path))) {
      signalled = true;
      setTimeout(() => child.kill('SIGINT'), 1500); // part way into b-long.mp4
    }
  });
  const code = await new Promise((resolve) => child.on('close', (c, s) => resolve(s || c)));
  assert.ok(signalled, 'the first file never finished: ' + stdout);
  assert.equal(code, 130, 'SIGINT is exit 130');
  const into = folder + ' (fitted)';
  const made = fs.existsSync(into) ? fs.readdirSync(into).sort() : [];
  assert.deepEqual(made.filter((f) => !/^a-fits\./.test(f)), [], 'something besides the finished file was left: ' + made.join(', '));
  assert.ok(made.some((f) => /^a-fits\./.test(f)), 'the finished file was not kept');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['a.png', 'b-long.mp4', 'c.png']);
  assert.ok(!lines(stdout).some((o) => /c\.png/.test(o.input || '')), 'the file after the stopped one was started');
});
