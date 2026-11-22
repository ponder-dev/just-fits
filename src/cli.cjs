#!/usr/bin/env node
'use strict';

/*
 * Just Fits on the command line.
 *
 * The decisions live in plan.js and the ffmpeg work in engine.cjs, neither of
 * which knows anything about Electron, so this is a wrapper rather than a
 * second implementation. The desktop app and this produce identical output for
 * identical input.
 *
 * Progress goes to stderr so stdout stays clean enough to pipe.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('./plan.js');
const engine = require('./engine.cjs');
const binaries = require('./binaries.cjs');
const { scan, places } = require('./scan.cjs');

// Inside a packaged app the extras sit in the app's resources folder (as
// extraResources put them), not in vendor/. Run that way, by the tool belt or
// anyone, process.resourcesPath says where; under plain node it is undefined
// and only vendor/ is looked in.
const packaged = (name) => (process.resourcesPath ? [path.join(process.resourcesPath, name)] : []);
const VENDOR = [...packaged('ffmpeg'), path.join(__dirname, '..', 'vendor', 'ffmpeg')];
const MB = 1000 * 1000;
// Names a video must not be given with -o: it comes out as an MP4, so a .mov or
// a .png would be a file named for what it is not.
const VIDEO_WRONG = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mov', '.mkv', '.webm', '.avi', '.heic'];

function human(bytes) {
  if (bytes >= 1000 * MB) return (bytes / 1000 / MB).toFixed(1) + 'GB';
  if (bytes >= MB) return (bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1) + 'MB';
  return Math.max(1, Math.round(bytes / 1000)) + 'KB';
}

const VERSION = require('../package.json').version;

/*
 * Every option, once. --help is printed from this and --describe is built from
 * it, so the two cannot drift apart (CONTRACT.md section 3).
 */
const OPTIONS = [
  { flags: ['--to'], name: 'to', metavar: 'target', type: 'string', default: 'discord', help: 'where it is going, or a plain size like 25MB' },
  { flags: ['-o', '--output', '--out'], name: 'output', metavar: 'path', type: 'path', default: null, help: 'where to write it (one file). "-" means stdout. default: beside the input as name-fits.mp4; a folder\'s go into a new "folder (fitted)" beside it' },
  { flags: ['--json'], name: 'json', type: 'boolean', help: 'results as JSON lines on stdout (stderr when the file goes to stdout)' },
  { flags: ['--progress'], name: 'progress', type: 'boolean', help: 'with --json, progress as JSON lines on stderr' },
  { flags: ['--beside'], name: 'beside', type: 'boolean', help: 'with a folder, save each result beside its original as name-fits instead of in a new "folder (fitted)"' },
  { flags: ['--dry-run'], name: 'dry-run', type: 'boolean', help: 'say what would happen and write nothing' },
  { flags: ['-q', '--quiet'], name: 'quiet', type: 'boolean', help: 'nothing on stderr but errors' },
  { flags: ['-h', '--help'], name: 'help', type: 'boolean', help: 'this, and nothing else' },
  { flags: ['-V', '--version'], name: 'version', type: 'boolean', help: 'the version number' },
  { flags: ['--describe'], name: 'describe', type: 'boolean', help: 'what this command line accepts, as JSON' },
];

const EXIT = [
  { code: 0, meaning: 'Done, or it already fit.' },
  { code: 1, meaning: 'Failed. Nothing usable was written.' },
  { code: 2, meaning: 'Usage: a bad option, a missing value, an unknown target or a missing input. Nothing was started.' },
  { code: 3, meaning: 'Several files: some were done and some failed. Each file has its own line under --json.' },
  { code: 4, meaning: 'Done, but still over the target after every try. The closest result was written.' },
  { code: 129, meaning: 'Stopped by a hang-up. Part files removed.' },
  { code: 130, meaning: 'Stopped with Ctrl-C. Part files removed.' },
  { code: 143, meaning: 'Stopped by a terminate signal. Part files removed.' },
];

function usage() {
  const targets = plan.TARGETS.map((t) => `    ${t.id.padEnd(16)} ${human(t.bytes).padStart(7)}   ${t.label}`).join('\n');
  const opts = OPTIONS.map((o) => {
    const left = `  ${o.flags.join(', ')}${o.metavar ? ` <${o.metavar}>` : ''}`;
    return `${left.padEnd(30)} ${o.help}`;
  }).join('\n');
  return `Just Fits ${VERSION}
Makes a file small enough to send.

  justfits <file> [options]
  justfits <file> <file> ... [options]
  justfits <folder> [options]
  cat clip.mp4 | justfits --to discord > small.mp4

Several files, or a folder (its subfolders too), are each fitted on their
own to the same target. Files are saved beside their originals; a folder's
go into a new folder beside it, "folder (fitted)", with the files that
already fit copied in so it is complete (--beside: beside each original).

Options
${opts}

Targets
${targets}

Exit status: 0 done, 1 failed, 2 usage, 3 some of several failed,
4 still over the target after every try.

Your original is only ever read. Nothing is uploaded.`;
}

function describe() {
  return {
    schema: 'ponderdev.cli-describe/1',
    name: 'justfits',
    product: 'Just Fits',
    version: VERSION,
    licence: require('../package.json').license,
    // The kit the app is built with (decided 2026-11-20), from the kit's own copy.
    kit: require('./kit/scan.cjs').VERSION,
    command: 'justfits',
    job: 'Make a video or image small enough to send, under an exact size limit.',
    network: false,
    accepts: { mediaTypes: ['video/*', 'image/*'], extensions: ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif'] },
    emits: { mediaTypes: ['video/mp4', 'image/jpeg'], extensions: ['.mp4', '.jpg'] },
    arguments: [{ name: 'file', type: 'path', required: false, repeatable: true, help: 'the file to shrink, or several, or a folder of them (subfolders too). "-" or none reads stdin' }],
    options: OPTIONS.map((o) => (o.name === 'to' ? { ...o, values: plan.TARGETS.map((t) => t.id), valuesOpen: true } : o)),
    targets: plan.TARGETS.map((t) => ({ id: t.id, bytes: t.bytes, label: t.label })),
    output: { video: 'name-fits.mp4 beside the input', picture: 'name-fits.jpg beside the input', taken: 'name-fits 2.mp4, then 3, never over an existing file', withO: '-o names the result: a video must end in .mp4 and a picture in .jpg. A file that already fits is copied to -o as it is and reported as a result line, not a skip, and may keep its own extension', several: 'each file fitted on its own; files named on their own beside their originals, a folder\'s into a new folder beside it, "folder (fitted)" (then "folder (fitted) 2"), subfolders mirrored, each result named name-fits as beside its original, files that already fit copied in under that name so the folder is complete, the folder itself untouched; --beside puts every result beside its original instead; -o and stdin take one file only' },
    result: { fields: { input: 'path', output: 'path', path: 'path', before: 'integer', after: 'integer', target: 'integer', attempts: 'integer', width: 'integer', height: 'integer', notes: 'array of strings, present when the video is long for the target (a small, blurry or softer picture)' } },
    // The desktop app carries ffmpeg; the npm command line uses the one on the
    // PATH, and says how to install it if there is none.
    needs: [{ id: 'ffmpeg', kind: 'binary', bundled: 'in the desktop app; the npm install uses ffmpeg from the PATH' }],
    io: {
      stdin: 'read when the file is "-", or when no file is named and stdin is not a terminal (gives up after 10 seconds of nothing)',
      stdout: 'the file itself with -o -, or when the input came from stdin and no -o was given; otherwise JSON lines with --json, otherwise nothing',
      stderr: 'progress and messages for people; JSON lines when stdout carries the file',
    },
    exitCodes: EXIT,
    guarantees: ['never writes over an input or an existing file', 'nothing is uploaded'],
  };
}

class UsageError extends Error {}

function parseTarget(value) {
  if (value === null) return plan.TARGETS[0];
  const preset = plan.TARGETS.find((t) => t.id === value.toLowerCase());
  if (preset) return preset;

  const m = /^(\d+(?:\.\d+)?)\s*(?:(g|m|k)b?|(b))?$/i.exec(value.trim());
  if (!m) throw new UsageError(`Unknown target "${value}". Try a preset from --help, or a size like 25MB.`);
  // "8b" is eight bytes, which nothing fits in, and it used to be read as 8MB.
  // Refused rather than guessed: 8MB and 8KB are both one letter away.
  if (m[3]) throw new UsageError(`Target "${value}" is in bytes. Did you mean ${m[1]}MB or ${m[1]}KB?`);
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const bytes = Math.round(n * (unit === 'g' ? 1000 * MB : unit === 'k' ? 1000 : MB));
  if (!(bytes > 0)) throw new UsageError(`Target "${value}" is not more than zero.`);
  return { id: 'custom', label: `${value}`, bytes };
}

// A missing or empty value is an error, never a silent default: a script
// passing an empty variable must not get a 10MB Discord file it did not ask
// for, or a file named after the next flag.
function needValue(flag, value, dashOk) {
  if (value === undefined || value === '' || (value.startsWith('-') && !(dashOk && value === '-'))) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

function parseArgs(argv) {
  const opts = { file: null, files: [], to: null, out: null, json: false, quiet: false, progress: false, dryRun: false, beside: false };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (positional || a === '-' || !a.startsWith('-')) {
      opts.files.push(a);
      if (opts.file === null) opts.file = a;
    }
    else if (a === '--') positional = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--progress') opts.progress = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--beside') opts.beside = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '--to') opts.to = needValue(a, argv[++i], false);
    else if (a === '-o' || a === '--out' || a === '--output') opts.out = needValue(a, argv[++i], true);
    else if (a.startsWith('--to=')) opts.to = needValue('--to', a.slice(5), false);
    else if (a.startsWith('--out=')) opts.out = needValue('--out', a.slice(6), true);
    else if (a.startsWith('--output=')) opts.out = needValue('--output', a.slice(9), true);
    else throw new UsageError(`Unknown option "${a}"`);
  }
  return opts;
}

// Checked before the encode rather than left to ffmpeg, whose complaint would
// name the working file it writes beside the result instead of the folder
// that is missing.
function checkFolder(requested, outPath) {
  const dir = path.dirname(outPath);
  let stat = null;
  try { stat = fs.statSync(dir); } catch (e) { /* missing, said below */ }
  if (!stat) throw new UsageError(`The folder ${path.dirname(requested)} does not exist.`);
  if (!stat.isDirectory()) throw new UsageError(`${path.dirname(requested)} is not a folder.`);
}

// Reads all of stdin into a file. When nobody asked for stdin (no file named,
// no "-"), an open pipe that never sends anything is almost always a harness
// or CI job with a missing file argument, so give up with a usage error
// instead of hanging forever.
function readStdin(dest, implicit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let got = 0;
    const timer = implicit ? setTimeout(() => {
      if (got) return;
      process.stdin.unpipe(out);
      process.stdin.destroy();
      out.destroy();
      reject(new Error('No input file, and nothing arrived on stdin. Name a file, or pass "-" to wait for stdin.'));
    }, 10000) : null;
    process.stdin.on('data', (c) => { got += c.length; });
    process.stdin.pipe(out);
    out.on('finish', () => {
      clearTimeout(timer);
      if (!got) reject(new Error('Nothing arrived on stdin.'));
      else resolve();
    });
    out.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// Waits until everything written to stdout has been handed to the OS, so
// exiting straight after cannot cut the end off a piped file.
function drainStdout() {
  return new Promise((resolve) => process.stdout.write('', () => resolve()));
}

/*
 * JSON lines (CONTRACT.md section 4): result, skip and error lines, then a
 * done line, always. They go to stdout, or to stderr when stdout carries the
 * file. The released fields (ok, path, before, after...) are kept as they were
 * so a script reading them keeps working; type, input, output and done are new.
 */
const report = {
  stream: process.stdout,
  on: false,
  counts: { results: 0, skipped: 0, failed: 0 },
  line(obj) { if (this.on) this.stream.write(JSON.stringify(obj) + '\n'); },
  result(obj) { this.counts.results++; this.line({ type: 'result', ...obj }); },
  skip(obj) { this.counts.skipped++; this.line({ type: 'skip', ...obj }); },
  error(code, message, input) { this.counts.failed++; this.line({ type: 'error', ok: false, code, message, ...(input ? { input } : {}) }); },
  done(exit) { this.line({ type: 'done', ok: exit === 0, ...this.counts, exit }); },
};

// Files to remove if a signal stops the run before it finishes.
const cleanup = new Set();
// A results folder made for the file being fitted ([dir, folder]), removed on
// a signal only if it is still empty.
let emptyIfStopped = null;
function removeIfEmpty([dir, folder]) {
  for (; dir.startsWith(folder); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { break; }
    if (dir === folder) break;
  }
}

async function main(argv) {
  // Answered before anything else is looked at: a bad option beside them still
  // gets an answer, no file is opened and stdin is never read.
  if (argv.includes('-h') || argv.includes('--help')) { console.log(usage()); return 0; }
  if (argv.includes('-V') || argv.includes('--version')) { console.log(VERSION); return 0; }
  if (argv.includes('--describe')) { console.log(JSON.stringify(describe(), null, 2)); return 0; }

  report.on = argv.includes('--json');
  const opts = parseArgs(argv);

  const target = parseTarget(opts.to);

  // Several inputs, or a folder: each one fitted on its own (fitMany). One file
  // goes the way it always has, below, so its output and JSON are unchanged.
  const isFolder = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (opts.files.length > 1 || (opts.files.length === 1 && opts.files[0] !== '-' && isFolder(opts.files[0]))) {
    return fitMany(opts, target);
  }

  // Piped input has to be buffered, because two-pass encoding reads the input
  // twice and a pipe cannot be rewound. Said plainly rather than hidden.
  let input = opts.file;
  let temp = null;
  const fromStdin = input === '-' || (!input && !process.stdin.isTTY);
  const toStdout = opts.out === '-' || (fromStdin && !opts.out);
  if (toStdout) report.stream = process.stderr;
  // Never over an existing file, the input included: `-o clip.mp4` on
  // clip.mp4 used to replace the original with the compressed copy.
  const outPath = opts.out && !toStdout ? path.resolve(opts.out) : null;
  // Before the exists check, which a device can pass on Windows.
  if (outPath && plan.isDeviceName(opts.out)) {
    throw new UsageError(`${opts.out.split(/[\\/]/).pop()} is a name Windows keeps for a device, so nothing would be saved. Choose another name.`);
  }
  if (outPath && fs.existsSync(outPath)) throw new UsageError(`Will not overwrite ${outPath}, it already exists.`);
  if (outPath) checkFolder(opts.out, outPath);
  if (!fromStdin && !fs.existsSync(input)) throw new UsageError(`No such file: ${input}`);

  const ffmpeg = binaries.resolve('ffmpeg', VENDOR);
  const ffprobe = binaries.resolve('ffprobe', VENDOR);

  let encodeDir = null;
  try {
    if (fromStdin) {
      temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-')), 'input');
      cleanup.add(path.dirname(temp));
      if (!opts.quiet) process.stderr.write('Buffering stdin, two passes cannot read a pipe twice\n');
      await readStdin(temp, input !== '-');
      input = temp;
    }

    let info;
    try {
      info = await engine.probe(ffprobe, input);
    } catch (err) {
      // A file it can read but will not shrink says why in its own words.
      if (err.code === 'animated-webp') throw err;
      // ffmpeg's own words ("Invalid data found when processing input") say
      // nothing to a person. The same sentence the window uses.
      throw Object.assign(new Error(`${fromStdin ? 'What arrived on stdin' : path.basename(input)} is not a video or picture that Just Fits can read.`), { code: 'not-media' });
    }
    // A picture comes out as a JPEG and a video as an MP4. Asked for the other,
    // the encode would fail late or write a file named for what it is not. A
    // file that already fits is copied as it is, so it may keep its own kind of
    // name (an already small PNG to copy.png). Stdin has no name of its own, and
    // the temp file it is buffered into must not turn up in a sentence.
    if (outPath) {
      const ext = path.extname(outPath).toLowerCase();
      const same = !fromStdin && ext === path.extname(input).toLowerCase();
      const called = fromStdin ? 'What arrived on stdin' : path.basename(input);
      if (info.kind === 'image' && !['.jpg', '.jpeg'].includes(ext) && !(same && info.bytes <= target.bytes)) {
        throw new UsageError(`${called} is a picture, so it comes out as a JPEG. Give -o a name ending in .jpg.`);
      }
      if (info.kind === 'video' && VIDEO_WRONG.includes(ext) && !(same && info.bytes <= target.bytes)) {
        throw new UsageError(`${called} is a video, so it comes out as an MP4. Give -o a name ending in .mp4.`);
      }
    }
    const fits = info.bytes <= target.bytes && !toStdout;
    if (opts.dryRun) {
      const ext = info.kind === 'image' ? '.jpg' : '.mp4';
      const would = fits ? (outPath || path.resolve(input)) : (outPath || (toStdout ? '-' : engine.outputPath(path.resolve(input), ext)));
      report.result({ ok: true, dryRun: true, input: fromStdin ? '-' : path.resolve(input), output: would, before: info.bytes, target: target.bytes, fits });
      if (!opts.quiet && !report.on) {
        process.stderr.write(fits ? `${human(info.bytes)} already fits under ${human(target.bytes)}. Nothing would change.\n`
          : `${human(info.bytes)} would be fitted under ${human(target.bytes)}${outPath ? `, to ${outPath}` : ''}.\n`);
      }
      return 0;
    }
    if (fits) {
      // Same streams and same JSON shape as a real fit, and the file is where
      // the caller asked for it, so a script can use the path either way.
      let finalPath = path.resolve(input);
      if (outPath) {
        fs.copyFileSync(input, outPath, fs.constants.COPYFILE_EXCL);
        finalPath = outPath;
      }
      const fields = {
        ok: true, skipped: true, path: finalPath, input: path.resolve(input), output: finalPath,
        before: info.bytes, after: info.bytes, target: target.bytes, bytes: info.bytes,
      };
      if (outPath) report.result(fields);
      else report.skip({ ...fields, reason: 'fits-already', message: `${human(info.bytes)} already fits under ${human(target.bytes)}.` });
      if (!report.on && !opts.quiet) {
        process.stderr.write(`${human(info.bytes)} already fits under ${human(target.bytes)}. Nothing to do.${outPath ? `  ${outPath}` : ''}\n`);
      }
      return 0;
    }

    // Too long for the target at any quality worth having: say so before
    // minutes of encoding, not after. It still tries, and exit 4 says if it
    // stayed over.
    const notes = [];
    if (info.kind === 'video') {
      const note = plan.lengthNote(plan.planVideo({ ...info, targetBytes: target.bytes }), human(target.bytes));
      if (note) notes.push(note);
      if (notes.length && !report.on && !opts.quiet) process.stderr.write(notes[0] + '\n');
    }

    let last = '';
    const onProgress = ({ stage, progress }) => {
      if (report.on && opts.progress) {
        process.stderr.write(JSON.stringify({ type: 'progress', stage, percent: Math.round(progress * 100) }) + '\n');
        return;
      }
      if (opts.quiet || opts.json || !process.stderr.isTTY) return;
      const line = `\r${stage} ${Math.round(progress * 100)}%   `;
      if (line !== last) { process.stderr.write(line); last = line; }
    };

    const args = { ffmpeg, file: input, info, targetBytes: target.bytes, onProgress, called: fromStdin ? 'what arrived on stdin' : undefined };
    // Writing to stdout still encodes to a real file first, for the same
    // reason: the encoder needs somewhere it can seek.
    if (toStdout) { args.outDir = encodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-out-')); cleanup.add(encodeDir); }
    else if (outPath) args.outDir = path.dirname(outPath);

    const result = info.kind === 'image' ? await engine.fitImage(args) : await engine.fitVideo(args);
    if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\r\x1b[K');

    let finalPath = result.path;
    if (toStdout) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(result.path);
        rs.pipe(process.stdout);
        rs.on('end', res); rs.on('error', rej);
      });
      await drainStdout();
      finalPath = '-';
    } else if (outPath) {
      // Checked again, since the encode can take minutes.
      if (fs.existsSync(outPath)) throw new Error(`Will not overwrite ${outPath}, it appeared during the encode. The result is at ${result.path}`);
      fs.renameSync(result.path, outPath);
      finalPath = outPath;
    }

    report.result({
      ok: !result.over, path: finalPath, input: fromStdin ? '-' : path.resolve(opts.file), output: finalPath,
      before: info.bytes, after: result.bytes, bytes: result.bytes,
      target: target.bytes, attempts: result.attempts,
      width: result.plan.width, height: result.plan.height,
      ...(notes.length ? { notes } : {}),
    });
    if (!report.on && !opts.quiet) {
      const saved = Math.round((1 - result.bytes / info.bytes) * 100);
      const where = finalPath === '-' ? '' : `  ${finalPath}`;
      process.stderr.write(result.over
        ? `Got to ${human(result.bytes)}, still over ${human(target.bytes)}.${where}\n`
        : `${human(info.bytes)} to ${human(result.bytes)}, ${saved}% smaller.${where}\n`);
    }
    return result.over ? 4 : 0;
  } finally {
    if (temp) fs.rmSync(path.dirname(temp), { recursive: true, force: true });
    if (encodeDir) fs.rmSync(encodeDir, { recursive: true, force: true });
  }
}

/*
 * Several files, or a folder of them: each fitted on its own to the same
 * target, one after another: a file named on its own beside its original, a
 * folder's into a new "folder (fitted)" beside it (--beside: beside each
 * original instead). Every file gets its own
 * JSON line, a result, a skip or an error with its input, so one that fails
 * does not stop the rest. Exit 0 when all fit, 4 when none failed but some
 * stayed over, 3 when some failed and 1 when all did.
 */
async function fitMany(opts, target) {
  if (opts.out) throw new UsageError('-o names one file. With several files or a folder, each result is saved beside its original.');
  if (opts.files.includes('-')) throw new UsageError('stdin ("-") is one file on its own, and cannot be mixed with other inputs.');
  const found = await scan(opts.files);
  if (found.missing.length) throw new UsageError(`No such file: ${found.missing[0]}`);
  if (!found.files.length) throw new UsageError(`There are no videos or pictures in ${opts.files.join(', ')}.`);

  const ffmpeg = binaries.resolve('ffmpeg', VENDOR);
  const ffprobe = binaries.resolve('ffprobe', VENDOR);
  const say = (line) => { if (!report.on && !opts.quiet) process.stderr.write(line + '\n'); };
  const total = found.files.length;
  const tally = { fitted: 0, over: 0, skipped: 0, failed: 0 };
  const place = places({ beside: opts.beside });
  const folders = new Set();

  for (const [i, f] of found.files.entries()) {
    const tag = `[${i + 1}/${total}] ${f.name}`;
    let info;
    try {
      info = await engine.probe(ffprobe, f.path);
    } catch (err) {
      const animated = err.code === 'animated-webp';
      const message = animated ? err.message : `${f.name} is not a video or picture that Just Fits can read.`;
      report.error(animated ? 'animated-webp' : 'not-media', message, f.path);
      tally.failed++;
      say(`${tag}: ${message}`);
      continue;
    }

    const fits = info.bytes <= target.bytes;
    const where = place(f);
    // Already small enough in a folder's results folder: copied in as it is,
    // so the results folder holds the whole folder (decided 2026-11-20).
    const copyIn = fits && Boolean(where.folder);
    const ext = fits ? path.extname(f.path) : info.kind === 'image' ? '.jpg' : '.mp4';
    if (opts.dryRun) {
      const would = fits && !copyIn ? f.path : engine.outputPath(where.outDir ? path.join(where.outDir, f.name) : f.path, ext, fs.existsSync, where.suffix);
      report.result({ ok: true, dryRun: true, input: f.path, output: would, before: info.bytes, target: target.bytes, fits });
      say(`${tag}: ${fits ? `${human(info.bytes)} already fits. Nothing would change.` : `${human(info.bytes)} would be fitted under ${human(target.bytes)}.`}`);
      continue;
    }
    if (fits) {
      let output = f.path;
      if (copyIn) {
        try {
          fs.mkdirSync(where.outDir, { recursive: true });
          output = engine.outputPath(path.join(where.outDir, f.name), ext, fs.existsSync, where.suffix);
          fs.copyFileSync(f.path, output, fs.constants.COPYFILE_EXCL);
          folders.add(where.folder);
        } catch (err) {
          report.error('failed', String(err.message || err), f.path);
          tally.failed++;
          say(`${tag}: ${String(err.message || err)}`);
          continue;
        }
      }
      report.skip({
        ok: true, skipped: true, path: output, input: f.path, output,
        before: info.bytes, after: info.bytes, target: target.bytes, bytes: info.bytes,
        reason: 'fits-already', ...(copyIn ? { copied: true } : {}),
        message: `${human(info.bytes)} already fits under ${human(target.bytes)}.${copyIn ? ' Copied in as it is.' : ''}`,
      });
      tally.skipped++;
      say(`${tag}: ${human(info.bytes)} already fits under ${human(target.bytes)}. ${copyIn ? `Copied in as it is.  ${output}` : 'Nothing to do.'}`);
      continue;
    }

    const notes = [];
    if (info.kind === 'video') {
      const note = plan.lengthNote(plan.planVideo({ ...info, targetBytes: target.bytes }), human(target.bytes));
      if (note) notes.push(note);
    }

    let last = '';
    const onProgress = ({ stage, progress }) => {
      if (report.on && opts.progress) {
        process.stderr.write(JSON.stringify({ type: 'progress', stage, percent: Math.round(progress * 100), input: f.path, file: i + 1, files: total }) + '\n');
        return;
      }
      if (opts.quiet || opts.json || !process.stderr.isTTY) return;
      const line = `\r${tag} ${stage} ${Math.round(progress * 100)}%   `;
      if (line !== last) { process.stderr.write(line); last = line; }
    };

    let result;
    try {
      if (where.outDir) fs.mkdirSync(where.outDir, { recursive: true });
      if (where.folder) emptyIfStopped = [where.outDir, where.folder];
      const args = { ffmpeg, file: f.path, info, targetBytes: target.bytes, onProgress, outDir: where.outDir, suffix: where.suffix };
      result = info.kind === 'image' ? await engine.fitImage(args) : await engine.fitVideo(args);
      emptyIfStopped = null;
      if (where.folder) folders.add(where.folder);
    } catch (err) {
      // A results folder made for this file and left empty goes again.
      if (where.folder) removeIfEmpty([where.outDir, where.folder]);
      emptyIfStopped = null;
      if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      report.error(err.code || 'failed', String(err.message || err), f.path);
      tally.failed++;
      say(`${tag}: ${String(err.message || err)}`);
      continue;
    }
    if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\r\x1b[K');

    report.result({
      ok: !result.over, path: result.path, input: f.path, output: result.path,
      before: info.bytes, after: result.bytes, bytes: result.bytes,
      target: target.bytes, attempts: result.attempts,
      width: result.plan.width, height: result.plan.height,
      ...(notes.length ? { notes } : {}),
    });
    if (result.over) tally.over++; else tally.fitted++;
    const saved = Math.round((1 - result.bytes / info.bytes) * 100);
    say(result.over
      ? `${tag}: got to ${human(result.bytes)}, still over ${human(target.bytes)}.  ${result.path}`
      : `${tag}: ${human(info.bytes)} to ${human(result.bytes)}, ${saved}% smaller.  ${result.path}`);
  }

  const bits = [`${tally.fitted} fitted`];
  if (tally.skipped) bits.push(`${tally.skipped} already small enough`);
  if (tally.over) bits.push(`${tally.over} still over ${human(target.bytes)}`);
  if (tally.failed) bits.push(`${tally.failed} failed`);
  if (!opts.dryRun) say(`${total} files: ${bits.join(', ')}.${folders.size ? ` Saved in ${[...folders].join(', ')}` : ''}`);

  if (tally.failed === total) return 1;
  if (tally.failed) return 3;
  return tally.over ? 4 : 0;
}

// A reader that stops early (`| head`) is not an error worth a stack trace.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  process.stderr.write(String(err.message || err) + '\n');
  process.exit(1);
});

// Stopped by a signal: remove what this run made, and say so with the code
// the contract gives each signal.
for (const [sig, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    for (const p of cleanup) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* gone already */ } }
    if (emptyIfStopped) removeIfEmpty(emptyIfStopped);
    process.exit(code);
  });
}

module.exports = { describe, usage, OPTIONS, EXIT };

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (code) => { report.done(code); await drainStdout(); process.exit(code); })
    .catch(async (err) => {
      const usageError = err instanceof UsageError;
      const code = usageError ? 2 : 1;
      report.error(usageError ? 'usage' : (err.code || 'failed'), String(err.message || err));
      process.stderr.write(String(err.message || err) + '\n');
      report.done(code);
      await drainStdout();
      process.exit(code);
    });
}
