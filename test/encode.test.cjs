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

const binaries = require('../src/binaries.cjs');

// The app's own resolver, so this test follows the vendor naming the app
// uses instead of keeping a second copy of it that can drift.
const vendor = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const FFMPEG = binaries.resolve('ffmpeg', [vendor]);
const FFPROBE = binaries.resolve('ffprobe', [vendor]);
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

test('a still image is recognized and shrunk', { timeout: 300000 }, async () => {
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
  // A half-written file under a "fits" name would look sendable.
  assert.ok(!fs.existsSync(path.join(dir, 'cancel-fits.mp4')), 'cancel left a partial output behind');
  // x264's two-pass logs, the ones it was still writing (.temp) included.
  const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`justfits-${process.pid}-`));
  assert.deepEqual(left, [], 'cancel left pass logs in the temp folder');
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

// An ffprobe older than 7.0 has no -show_stream_groups and refuses it, as
// Debian 12's and Ubuntu 24.04's do. Stood in for by a wrapper that refuses it
// the way they do and passes anything else to the real one.
test('an ffprobe without stream groups still reads files', { skip: process.platform === 'win32' && 'the stand-in is a shell script', timeout: 120000 }, async () => {
  const old = path.join(dir, 'old-ffprobe');
  fs.writeFileSync(old, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-show_stream_groups" ]; then
    echo "Unrecognized option 'show_stream_groups'." >&2
    echo "Error splitting the argument list: Option not found" >&2
    exit 1
  fi
done
exec ${JSON.stringify(path.resolve(FFPROBE))} "$@"
`, { mode: 0o755 });
  const src = makeVideo('old-probe.mp4', 2, '320x240', 25);
  const info = await engine.probe(old, src);
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
  await assert.rejects(engine.probe(old, path.join(dir, 'missing.mp4')));
});

// A portrait photo from a phone is a landscape grid of tiles with its rotation
// on the grid, not on the first tile. ffmpeg turns the joined picture upright
// before the scale, so the size has to be the upright one or the photo comes
// out squashed into a landscape frame. Stood in for by an ffprobe that answers
// the way the real one does for an iPhone portrait (4032x3024 grid, -90).
// Builds differ on where they put the turn: some on the grid's component,
// newer ones (late 2026) on the group itself. Both have to read upright.
test('a rotated tiled HEIC reads in the shape it is shown', { skip: process.platform === 'win32' && 'the stand-in is a shell script' }, async () => {
  const turn = (rotation) => (rotation === undefined ? [] : [{ side_data_type: 'Display Matrix', rotation }]);
  const answer = (rotation, onGroup = false) => JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', nb_streams: 2 },
    streams: [{ index: 0, codec_type: 'video', width: 512, height: 512, r_frame_rate: '1/1', nb_frames: '1', disposition: { attached_pic: 0 } }],
    stream_groups: [{ index: 0, type: 'Tile Grid', components: [{
      nb_tiles: 48, width: 4032, height: 3024,
      side_data_list: [{ side_data_type: 'EXIF metadata' }, ...(onGroup ? [] : turn(rotation))],
    }], ...(onGroup ? { side_data_list: [{ side_data_type: 'EXIF metadata' }, ...turn(rotation)] } : {}) }],
  });
  const photo = path.join(dir, 'portrait.heic');
  fs.writeFileSync(photo, 'not read: the stand-in answers for it');
  const standIn = (name, rotation, onGroup) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${answer(rotation, onGroup)}\nJSON\n`, { mode: 0o755 });
    return file;
  };

  const portrait = await engine.probe(standIn('grid-portrait-ffprobe', -90), photo);
  assert.equal(portrait.width, 3024);
  assert.equal(portrait.height, 4032);
  assert.equal(portrait.grid, true);

  const onGroup = await engine.probe(standIn('grid-portrait-group-ffprobe', -90, true), photo);
  assert.equal(onGroup.width, 3024, 'the turn on the group, as newer ffprobe builds give it');
  assert.equal(onGroup.height, 4032);

  const landscape = await engine.probe(standIn('grid-landscape-ffprobe'), photo);
  assert.equal(landscape.width, 4032);
  assert.equal(landscape.height, 3024);
});

// Some phones (an iPhone 7, for one) write a portrait HEIC with no rotation box
// and only the turn in EXIF, which ffmpeg ignores for HEIC. The turn is read
// from the file itself and the picture is turned before the scale. The file
// here is built by hand (a HEIF skeleton with an Exif item and no irot), since
// ffmpeg here cannot encode HEIC, and the ffprobe is stood in as above.
function heifWithOrientation(orientation, { irot = false } = {}) {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const full = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

  // TIFF, little endian, one IFD0 entry: Orientation (0x0112), SHORT
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  const exif = Buffer.concat([u32(0), tiff]);

  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('mif1heic'));
  const props = irot ? box('irot', Buffer.from([1])) : box('pixi', Buffer.from([0]));
  const iprp = box('iprp', box('ipco', props));
  const ilocFor = (offset) => full('iloc', Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(exif.length));
  // infe is a FullBox with version 2: the version byte is the first of its four
  const infe = box('infe', Buffer.from([2, 0, 0, 0]), u16(1), u16(0), Buffer.from('Exif'), Buffer.from([0]));
  const iinf2 = full('iinf', u16(1), infe);
  const metaLen = (o) => full('meta', iinf2, ilocFor(o), iprp).length;
  const offset = ftyp.length + metaLen(0);
  return Buffer.concat([ftyp, full('meta', iinf2, ilocFor(offset), iprp), exif]);
}

test('a HEIC whose turn is only in its EXIF is read upright and turned', { skip: process.platform === 'win32' && 'the stand-in is a shell script', timeout: 120000 }, async () => {
  const heif = require('../src/heif.cjs');
  const write = (name, bytes) => { const f = path.join(dir, name); fs.writeFileSync(f, bytes); return f; };
  const exifOnly = write('exif6.heic', heifWithOrientation(6));
  assert.equal(heif.heifOrientation(exifOnly), 6);
  // A rotation box already carries the turn: ffmpeg applies it, so it is not turned twice.
  assert.equal(heif.heifOrientation(write('irot.heic', heifWithOrientation(6, { irot: true }))), 1);
  assert.equal(heif.heifOrientation(write('upright.heic', heifWithOrientation(1))), 1);

  const ffprobe = path.join(dir, 'exif-only-ffprobe');
  fs.writeFileSync(ffprobe, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', nb_streams: 2 },
    streams: [{ index: 0, codec_type: 'video', width: 512, height: 512, r_frame_rate: '1/1', nb_frames: '1', disposition: { attached_pic: 0 } }],
    stream_groups: [{ index: 0, type: 'Tile Grid', components: [{ nb_tiles: 48, width: 4032, height: 3024, side_data_list: [{ side_data_type: 'EXIF metadata' }] }] }],
  })}\nJSON\n`, { mode: 0o755 });
  const info = await engine.probe(ffprobe, exifOnly);
  assert.equal(info.width, 3024);
  assert.equal(info.height, 4032);
  assert.equal(info.orientation, 6);
  const flat = await engine.probe(ffprobe, write('upright2.heic', heifWithOrientation(1)));
  assert.equal(flat.width, 4032);
  assert.equal(flat.orientation, undefined);

  // The turn itself, with the real ffmpeg: a landscape picture asked to turn 6 comes out portrait.
  const src = path.join(dir, 'wide.png');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=400x200', '-frames:v', '1', src]);
  const out = await engine.fitImage({ ffmpeg: FFMPEG, file: src, info: { width: 200, height: 400, orientation: 6 }, targetBytes: 5 * MB, outDir: dir, suffix: '-turned' });
  const size = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out.path]).toString().trim();
  assert.equal(size, '200,400');
});

// A real iPhone portrait photo (a tiled grid with a rotation box), through the
// real engine and the bundled ffmpeg and ffprobe, nothing stood in: the result
// has to be portrait. See test/fixtures/phone-heic/README.md for where it is from.
test('a real iPhone portrait HEIC is fitted and comes out portrait', { timeout: 300000 }, async () => {
  const photo = path.join(__dirname, 'fixtures', 'phone-heic', 'portrait-arrow.heic');
  const info = await engine.probe(FFPROBE, photo);
  assert.equal(info.kind, 'image');
  assert.ok(info.height > info.width, `probed as ${info.width}x${info.height}`);
  const target = 300 * 1000;
  const r = await engine.fitImage({ ffmpeg: FFMPEG, file: photo, info, targetBytes: target, outDir: dir, suffix: '-iphone' });
  assert.ok(r.bytes <= target, `landed at ${Math.round(r.bytes / 1000)}KB`);
  const [w, h] = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.path]).toString().trim().split(',').map(Number);
  assert.ok(h > w, `the result is ${w}x${h}, not portrait`);
});
