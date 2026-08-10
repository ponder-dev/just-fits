'use strict';

/*
 * The real thing: makes a video, compresses it, checks it actually fits.
 *
 *   node test/encode.test.cjs
 *
 * Needs vendor/ffmpeg populated. Takes a minute or two, because it runs
 * genuine two-pass encodes rather than pretending.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../src/engine.cjs');

const vendor = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const exe = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = path.join(vendor, `ffmpeg-${process.arch}${exe}`);
const FFPROBE = path.join(vendor, `ffprobe-${process.arch}${exe}`);
const MB = 1000 * 1000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-test-'));

// Noisy moving source, so x264 cannot cheat its way to a tiny file and the
// size targeting is actually put under load.
function makeVideo(name, seconds, size, rate) {
  const out = path.join(dir, name);
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '9000k',
    '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', out,
  ]);
  return out;
}

test('a big clip is brought under a Discord free limit', { timeout: 600000 }, async () => {
  const src = makeVideo('big.mp4', 30, '1920x1080', 30);
  const before = fs.statSync(src).size;
  assert.ok(before > 10 * MB, `source should be over the limit, was ${(before / MB).toFixed(1)}MB`);

  const info = await engine.probe(FFPROBE, src);
  assert.equal(info.kind, 'video');
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.durationSec - 30) < 1);

  const r = await engine.fitVideo({ ffmpeg: FFMPEG, file: src, info, targetBytes: 10 * MB });

  assert.ok(!r.over, 'should have got under the limit');
  assert.ok(r.bytes <= 10 * MB, `landed at ${(r.bytes / MB).toFixed(2)}MB`);
  assert.ok(r.bytes > 6 * MB, `should use the budget, only used ${(r.bytes / MB).toFixed(2)}MB`);

  // The output must be a real, playable file, not just the right size.
  const out = await engine.probe(FFPROBE, r.path);
  assert.equal(out.hasAudio, true, 'sound survived');
  assert.ok(Math.abs(out.durationSec - info.durationSec) < 1, 'full length survived');

  console.log(`    ${(before / MB).toFixed(1)}MB -> ${(r.bytes / MB).toFixed(2)}MB ` +
    `(${out.width}x${out.height}, ${r.attempts} attempt${r.attempts > 1 ? 's' : ''})`);
});

test('the original is never touched', { timeout: 600000 }, async () => {
  const src = makeVideo('keep.mp4', 6, '1280x720', 30);
  const before = { size: fs.statSync(src).size, bytes: fs.readFileSync(src) };

  const info = await engine.probe(FFPROBE, src);
  const r = await engine.fitVideo({ ffmpeg: FFMPEG, file: src, info, targetBytes: 2 * MB });

  assert.notEqual(r.path, src, 'wrote somewhere else');
  assert.equal(fs.statSync(src).size, before.size, 'source size unchanged');
  assert.ok(before.bytes.equals(fs.readFileSync(src)), 'source bytes unchanged');
});

test('a second file does not overwrite the first result', () => {
  const a = path.join(dir, 'clash.mp4');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(path.join(dir, 'clash-fits.mp4'), 'x');
  const chosen = engine.outputPath(a, '.mp4');
  assert.equal(path.basename(chosen), 'clash-fits 2.mp4');
});

test('a still image is recognised and shrunk', { timeout: 300000 }, async () => {
  const src = path.join(dir, 'big.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=4000x3000', '-frames:v', '1', src]);

  const info = await engine.probe(FFPROBE, src);
  assert.equal(info.kind, 'image');

  const r = await engine.fitImage({ ffmpeg: FFMPEG, file: src, info, targetBytes: 400 * 1000 });
  assert.ok(r.bytes <= 400 * 1000, `landed at ${Math.round(r.bytes / 1000)}KB`);
  console.log(`    ${Math.round(info.bytes / 1000)}KB -> ${Math.round(r.bytes / 1000)}KB`);
});

test('cancelling stops the encode and reports it', { timeout: 300000 }, async () => {
  const src = makeVideo('cancel.mp4', 20, '1920x1080', 30);
  const info = await engine.probe(FFPROBE, src);
  const ctl = engine.control();

  const work = engine.fitVideo({ ffmpeg: FFMPEG, file: src, info, targetBytes: 5 * MB, ctl });
  setTimeout(() => ctl.cancel(), 700);

  await assert.rejects(work, (err) => err.cancelled === true);
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
