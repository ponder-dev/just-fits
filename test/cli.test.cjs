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
