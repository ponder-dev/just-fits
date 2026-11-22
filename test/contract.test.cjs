'use strict';

/*
 * The command-line contract (CONTRACT.md in the PonderDev tools workshop):
 * what every Just tool promises so a script, an assistant or the tool belt can
 * drive it without guessing.
 *
 *   node test/contract.test.cjs
 *
 * Fast: no encoding, except one short clip for the --json shapes.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.cjs');
const binaries = require('../src/binaries.cjs');
let FFMPEG;
try { FFMPEG = binaries.resolve('ffmpeg', [path.join(__dirname, '..', 'vendor', 'ffmpeg')]); } catch (e) { FFMPEG = null; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-contract-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, timeout: 60000, ...opts });
  const lines = (r.stdout || '').split('\n').flatMap((l) => { try { const o = JSON.parse(l); return o && o.type ? [o] : []; } catch (e) { return []; } });
  return { ...r, lines };
}

test('--help, --version and --describe answer first and do no work', () => {
  for (const flag of ['--help', '-V', '--describe']) {
    const before = fs.readdirSync(dir).length;
    // A bad option, a missing file and an open stdin pipe that never closes:
    // none of them may get in the way, and stdin must not be waited on.
    const r = spawnSync(process.execPath, [CLI, '--no-such-option', 'missing.mp4', flag], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, `${flag}: ${r.stderr}`);
    assert.equal(fs.readdirSync(dir).length, before, `${flag} wrote nothing`);
  }
});

test('--describe is the shared schema and matches --help', () => {
  const d = JSON.parse(run(['--describe']).stdout);
  assert.equal(d.schema, 'ponderdev.cli-describe/1');
  assert.equal(d.command, 'justfits');
  assert.equal(d.network, false);
  const help = run(['--help']).stdout;
  for (const o of d.options) for (const f of o.flags) assert.ok(help.includes(f), `--help lists ${f}`);
  // 3 is the contract's "partly done", for several files where some failed.
  assert.deepEqual(d.exitCodes.map((e) => e.code), [0, 1, 2, 3, 4, 129, 130, 143]);
  assert.equal(d.arguments[0].repeatable, true);
});

// The kit is named in four places (kit 1.0.0 is the decided name; the 1.2.x in
// older commit messages were private builds). They must all say what kit.lock
// says, and the kit's files must be the ones it locked.
test('the kit is the one kit.lock names, everywhere it is said', () => {
  const root = path.join(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'kit.lock'), 'utf8'));
  assert.match(lock.kit, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(run(['--describe']).stdout).kit, lock.kit, '--describe');
  assert.equal(require('../src/kit/scan.cjs').VERSION, lock.kit, 'kit/scan.cjs');
  assert.ok(fs.readFileSync(path.join(root, 'src', 'renderer', 'licenses.html'), 'utf8').includes(`PonderDev kit ${lock.kit},`), 'the licences page');
  assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes(`Built with kit ${lock.kit},`), 'README');
  for (const [file, hash] of Object.entries(lock.files)) {
    // Hashed with any \r taken out, so a checkout that turned LF into CRLF
    // (Windows, without .gitattributes) still matches what kit.lock locked.
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r/g, '');
    const got = require('node:crypto').createHash('sha256').update(text).digest('hex');
    assert.equal(got, hash, `${file} is not the file kit.lock locked`);
  }
});

test('usage errors exit 2, as JSON under --json, with a done line', () => {
  for (const args of [['--bogus'], ['x.mp4', '--to', 'nonsense'], ['missing.mp4'], ['a.mp4', 'b.mp4'], ['x.mp4', '--to']]) {
    const r = run([...args, '--json']);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.lines[0].type, 'error');
    assert.equal(r.lines[0].code, 'usage');
    assert.equal(r.lines.at(-1).type, 'done');
    assert.equal(r.lines.at(-1).exit, 2);
  }
});

test('a file that already fits is a skip, with the old fields kept', { skip: !FFMPEG }, () => {
  const clip = path.join(dir, 'small.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '1', '-pix_fmt', 'yuv420p', clip]);
  const r = run([clip, '--to', '50MB', '--json']);
  assert.equal(r.status, 0);
  const [skip, done] = r.lines;
  assert.equal(skip.type, 'skip');
  assert.equal(skip.reason, 'fits-already');
  assert.equal(skip.ok, true);
  assert.equal(skip.skipped, true);
  assert.equal(skip.path, clip);
  assert.equal(done.type, 'done');
  assert.equal(done.skipped, 1);
});

test('--dry-run writes nothing and names the output', { skip: !FFMPEG }, () => {
  const clip = path.join(dir, 'small.mp4');
  const before = fs.readdirSync(dir).sort();
  const r = run([clip, '--to', '1KB', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines[0].dryRun, true);
  assert.equal(r.lines[0].output, path.join(dir, 'small-fits.mp4'));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('still over the target is exit 4, and the result line says ok false', { skip: !FFMPEG, timeout: 300000 }, () => {
  const clip = path.join(dir, 'noisy.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'anoisesrc=d=4',
    '-t', '4', '-c:v', 'libx264', '-b:v', '8000k', '-pix_fmt', 'yuv420p', clip]);
  const r = run([clip, '--to', '5KB', '--json'], { timeout: 300000 });
  assert.equal(r.status, 4, r.stderr);
  const result = r.lines.find((l) => l.type === 'result');
  assert.equal(result.ok, false);
  assert.equal(r.lines.at(-1).exit, 4);
});
