'use strict';

/*
 * The promise: your file is only ever read.
 *
 *   node test/safety.test.cjs
 *
 * The whole app writes in exactly one place, the path engine.outputPath
 * returns, and deletes in exactly one place, x264's scratch logs in the system
 * temp folder. So the promise reduces to a single claim: outputPath can never
 * return the file it was given. This tries hard to make it do that.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const engine = require('../src/engine.cjs');

// Names chosen to collide if the naming rule were sloppy: ones that already
// look like output, ones differing only by case, and ones already carrying the
// numbered suffix the collision handler adds.
const NASTY = [
  'video.mp4', 'video-fits.mp4', 'video-fits 2.mp4', 'video-fits 999.mp4',
  'VIDEO.MP4', 'Video-Fits.mp4', 'video.MP4', 'video-fits.MP4',
  'a.mp4', '-fits.mp4', 'fits.mp4', '.mp4', 'no-extension',
  'two.dots.mp4', 'spaces everywhere.mp4', 'ünïcodé.mp4', "quote'name.mp4",
  'photo.jpg', 'photo-fits.jpg', 'photo.jpeg', 'photo.JPG',
];

test('the output is never the input, whatever it is called', () => {
  for (const name of NASTY) {
    for (const ext of ['.mp4', '.jpg']) {
      const source = path.join('/tmp/somewhere', name);
      const out = engine.outputPath(source, ext, () => false);
      assert.notEqual(out, source, `${name} -> ${out}`);
      assert.notEqual(out.toLowerCase(), source.toLowerCase(),
        `${name} -> ${out} differs only by case, which is the same file on mac`);
    }
  }
});

test('it stays away even when every name it tries is taken', () => {
  for (const name of NASTY) {
    const source = path.join('/tmp/somewhere', name);
    // Claim every path exists, so the collision loop runs to its limit.
    const out = engine.outputPath(source, '.mp4', () => true);
    assert.notEqual(out, source);
    assert.notEqual(out.toLowerCase(), source.toLowerCase());
  }
});

test('it lands beside the original, not somewhere else', () => {
  const source = '/tmp/a folder/clip.mp4';
  assert.equal(path.dirname(engine.outputPath(source, '.mp4', () => false)), '/tmp/a folder');
});

test('the only thing it deletes lives in the temp folder', () => {
  // Reading the source is the point of the exercise: this asserts on the code
  // that actually ships rather than on a description of it.
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.cjs'), 'utf8');
  const deletes = engineSource.match(/fs\.(unlink|unlinkSync|rm|rmSync|rename|renameSync)\w*\(([^)]*)\)/g) || [];
  assert.equal(deletes.length, 1, `expected one delete, found ${deletes.length}: ${deletes.join(' | ')}`);
  assert.match(deletes[0], /logFile/, 'the one delete must be the two-pass log');
  assert.match(engineSource, /logFile = path\.join\(os\.tmpdir\(\)/, 'and the log must live in the temp folder');

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.doesNotMatch(mainSource, /fs\.(unlink|rm|rename|writeFile)/, 'main must not touch the filesystem at all');
});

test('nothing in the app writes anywhere but the output path', () => {
  const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.cjs'), 'utf8');
  assert.doesNotMatch(engineSource, /fs\.(writeFile|writeFileSync|createWriteStream|appendFile)/,
    'the engine hands paths to ffmpeg and never writes files itself');
});

test('a real encode leaves the original byte for byte identical', { timeout: 300000 }, async () => {
  const vendor = path.join(__dirname, '..', 'vendor', 'ffmpeg');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const FFMPEG = path.join(vendor, `ffmpeg-${process.arch}${exe}`);
  const FFPROBE = path.join(vendor, `ffprobe-${process.arch}${exe}`);
  if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) return; // no binaries, nothing to prove here

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-safety-'));
  try {
    // Deliberately named as though it were already an output of ours.
    const src = path.join(dir, 'clip-fits.mp4');
    require('node:child_process').execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30', '-t', '3',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', src,
    ]);
    const before = fs.readFileSync(src);

    const info = await engine.probe(FFPROBE, src);
    const r = await engine.fitVideo({ ffmpeg: FFMPEG, file: src, info, targetBytes: 300 * 1000 });

    assert.notEqual(r.path, src);
    assert.ok(before.equals(fs.readFileSync(src)), 'the original changed, which must never happen');
    assert.ok(fs.existsSync(r.path), 'and the new file was actually written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
