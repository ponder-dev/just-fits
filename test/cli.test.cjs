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
const { execFileSync, execSync } = require('node:child_process');
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
  const r = JSON.parse(run([src, '--to', '2MB', '--out', out, '--json']));
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
  execSync(`cat ${JSON.stringify(src)} | ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} --to 2MB > ${JSON.stringify(out)} 2>/dev/null`);
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
  const r = JSON.parse(run([src, '--to', '500MB', '--json']));
  assert.equal(r.skipped, true);
});
