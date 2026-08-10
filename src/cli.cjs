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

const VENDOR = [path.join(__dirname, '..', 'vendor', 'ffmpeg')];
const MB = 1000 * 1000;

function human(bytes) {
  if (bytes >= 1000 * MB) return (bytes / 1000 / MB).toFixed(1) + 'GB';
  if (bytes >= MB) return (bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1) + 'MB';
  return Math.max(1, Math.round(bytes / 1000)) + 'KB';
}

function usage() {
  const targets = plan.TARGETS.map((t) => `    ${t.id.padEnd(16)} ${human(t.bytes).padStart(7)}   ${t.label}`).join('\n');
  return `Just Fits ${require('../package.json').version}
Makes a file small enough to send.

  justfits <file> [options]
  cat clip.mp4 | justfits --to discord > small.mp4

Options
  --to <target>     where it is going, or a plain size like 25MB. default: discord
  -o, --out <path>  where to write it. "-" means stdout.
                    default: alongside the input as name-fits.mp4
  --json            print the result as JSON instead of prose
  -q, --quiet       no progress
  -h, --help        this
  -V, --version     version

Targets
${targets}

Your original is only ever read. Nothing is uploaded.`;
}

function parseTarget(value) {
  if (!value) return plan.TARGETS[0];
  const preset = plan.TARGETS.find((t) => t.id === value.toLowerCase());
  if (preset) return preset;

  const m = /^(\d+(?:\.\d+)?)\s*(g|m|k)?b?$/i.exec(value.trim());
  if (!m) throw new Error(`Unknown target "${value}". Try a preset from --help, or a size like 25MB.`);
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const bytes = Math.round(n * (unit === 'g' ? 1000 * MB : unit === 'k' ? 1000 : MB));
  return { id: 'custom', label: `${value}`, bytes };
}

function parseArgs(argv) {
  const opts = { file: null, to: null, out: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    else if (a === '-V' || a === '--version') return { version: true };
    else if (a === '--json') opts.json = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--to=')) opts.to = a.slice(5);
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option "${a}"`);
    else if (!opts.file) opts.file = a;
    else throw new Error('Only one input file at a time');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return 0; }
  if (opts.version) { console.log(require('../package.json').version); return 0; }

  const target = parseTarget(opts.to);
  const ffmpeg = binaries.resolve('ffmpeg', VENDOR);
  const ffprobe = binaries.resolve('ffprobe', VENDOR);

  // Piped input has to be buffered, because two-pass encoding reads the input
  // twice and a pipe cannot be rewound. Said plainly rather than hidden.
  let input = opts.file;
  let temp = null;
  const fromStdin = input === '-' || (!input && !process.stdin.isTTY);
  if (fromStdin) {
    temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-')), 'input');
    if (!opts.quiet) process.stderr.write('Buffering stdin, two passes cannot read a pipe twice\n');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp);
      process.stdin.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    input = temp;
  }
  if (!input) { console.error(usage()); return 1; }
  if (!fs.existsSync(input)) throw new Error(`No such file: ${input}`);

  const toStdout = opts.out === '-' || (fromStdin && !opts.out);

  try {
    const info = await engine.probe(ffprobe, input);
    if (info.bytes <= target.bytes && !toStdout) {
      const msg = `${human(info.bytes)} already fits under ${human(target.bytes)}. Nothing to do.`;
      console.log(opts.json ? JSON.stringify({ ok: true, skipped: true, bytes: info.bytes }) : msg);
      return 0;
    }

    let last = '';
    const onProgress = ({ stage, progress }) => {
      if (opts.quiet || opts.json || !process.stderr.isTTY) return;
      const line = `\r${stage} ${Math.round(progress * 100)}%   `;
      if (line !== last) { process.stderr.write(line); last = line; }
    };

    const args = { ffmpeg, file: input, info, targetBytes: target.bytes, onProgress };
    // Writing to stdout still encodes to a real file first, for the same
    // reason: the encoder needs somewhere it can seek.
    if (toStdout) args.outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justfits-out-'));
    else if (opts.out) args.outDir = path.dirname(path.resolve(opts.out));

    const result = info.kind === 'image' ? await engine.fitImage(args) : await engine.fitVideo(args);
    if (!opts.quiet && !opts.json && process.stderr.isTTY) process.stderr.write('\r\x1b[K');

    let finalPath = result.path;
    if (toStdout) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(result.path);
        rs.pipe(process.stdout);
        rs.on('end', res); rs.on('error', rej);
      });
      finalPath = '-';
    } else if (opts.out) {
      fs.renameSync(result.path, path.resolve(opts.out));
      finalPath = path.resolve(opts.out);
    }

    if (opts.json) {
      console.log(JSON.stringify({
        ok: !result.over, path: finalPath, before: info.bytes, after: result.bytes,
        target: target.bytes, attempts: result.attempts,
        width: result.plan.width, height: result.plan.height,
      }));
    } else if (!opts.quiet) {
      const saved = Math.round((1 - result.bytes / info.bytes) * 100);
      const where = finalPath === '-' ? '' : `  ${finalPath}`;
      process.stderr.write(result.over
        ? `Got to ${human(result.bytes)}, still over ${human(target.bytes)}.${where}\n`
        : `${human(info.bytes)} to ${human(result.bytes)}, ${saved}% smaller.${where}\n`);
    }
    return result.over ? 2 : 0;
  } finally {
    if (temp) fs.rmSync(path.dirname(temp), { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(String(err.message || err) + '\n');
    process.exit(1);
  });
