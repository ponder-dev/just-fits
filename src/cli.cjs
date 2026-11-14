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

// Inside a packaged app the extras sit in the app's resources folder (as
// extraResources put them), not in vendor/. Run that way, by the tool belt or
// anyone, process.resourcesPath says where; under plain node it is undefined
// and only vendor/ is looked in.
const packaged = (name) => (process.resourcesPath ? [path.join(process.resourcesPath, name)] : []);
const VENDOR = [...packaged('ffmpeg'), path.join(__dirname, '..', 'vendor', 'ffmpeg')];
const MB = 1000 * 1000;

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
  { flags: ['-o', '--output', '--out'], name: 'output', metavar: 'path', type: 'path', default: null, help: 'where to write it. "-" means stdout. default: beside the input as name-fits.mp4' },
  { flags: ['--json'], name: 'json', type: 'boolean', help: 'results as JSON lines on stdout (stderr when the file goes to stdout)' },
  { flags: ['--progress'], name: 'progress', type: 'boolean', help: 'with --json, progress as JSON lines on stderr' },
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
  cat clip.mp4 | justfits --to discord > small.mp4

Options
${opts}

Targets
${targets}

Exit status: 0 done, 1 failed, 2 usage, 4 still over the target after every try.

Your original is only ever read. Nothing is uploaded.`;
}

function describe() {
  return {
    schema: 'ponderdev.cli-describe/1',
    name: 'justfits',
    product: 'Just Fits',
    version: VERSION,
    licence: require('../package.json').license,
    command: 'justfits',
    job: 'Make a video or image small enough to send, under an exact size limit.',
    network: false,
    accepts: { mediaTypes: ['video/*', 'image/*'], extensions: ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.jpg', '.jpeg', '.png', '.webp', '.gif'] },
    emits: { mediaTypes: ['video/mp4', 'image/jpeg'], extensions: ['.mp4', '.jpg'] },
    arguments: [{ name: 'file', type: 'path', required: false, repeatable: false, help: 'the file to shrink. "-" or none reads stdin' }],
    options: OPTIONS.map((o) => (o.name === 'to' ? { ...o, values: plan.TARGETS.map((t) => t.id), valuesOpen: true } : o)),
    targets: plan.TARGETS.map((t) => ({ id: t.id, bytes: t.bytes, label: t.label })),
    output: { video: 'name-fits.mp4 beside the input', picture: 'name-fits.jpg beside the input', taken: 'name-fits 2.mp4, then 3, never over an existing file' },
    result: { fields: { input: 'path', output: 'path', path: 'path', before: 'integer', after: 'integer', target: 'integer', attempts: 'integer', width: 'integer', height: 'integer' } },
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

  const m = /^(\d+(?:\.\d+)?)\s*(g|m|k)?b?$/i.exec(value.trim());
  if (!m) throw new UsageError(`Unknown target "${value}". Try a preset from --help, or a size like 25MB.`);
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
  const opts = { file: null, to: null, out: null, json: false, quiet: false, progress: false, dryRun: false };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (positional || a === '-' || !a.startsWith('-')) {
      if (opts.file !== null) throw new UsageError('Only one input file at a time');
      opts.file = a;
    }
    else if (a === '--') positional = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--progress') opts.progress = true;
    else if (a === '--dry-run') opts.dryRun = true;
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
  error(code, message) { this.counts.failed++; this.line({ type: 'error', ok: false, code, message }); },
  done(exit) { this.line({ type: 'done', ok: exit === 0, ...this.counts, exit }); },
};

// Files to remove if a signal stops the run before it finishes.
const cleanup = new Set();

async function main(argv) {
  // Answered before anything else is looked at: a bad option beside them still
  // gets an answer, no file is opened and stdin is never read.
  if (argv.includes('-h') || argv.includes('--help')) { console.log(usage()); return 0; }
  if (argv.includes('-V') || argv.includes('--version')) { console.log(VERSION); return 0; }
  if (argv.includes('--describe')) { console.log(JSON.stringify(describe(), null, 2)); return 0; }

  report.on = argv.includes('--json');
  const opts = parseArgs(argv);

  const target = parseTarget(opts.to);

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
      // ffmpeg's own words ("Invalid data found when processing input") say
      // nothing to a person. The same sentence the window uses.
      throw Object.assign(new Error(`${fromStdin ? 'What arrived on stdin' : path.basename(input)} is not a video or picture that Just Fits can read.`), { code: 'not-media' });
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

    const args = { ffmpeg, file: input, info, targetBytes: target.bytes, onProgress };
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
