'use strict';

/*
 * Driving ffmpeg.
 *
 * Knows nothing about Electron, so the whole compression path can be run and
 * tested from a plain node script. main.cjs supplies the binary paths and
 * turns the callbacks into IPC.
 *
 * The original file is only ever read. Everything is written to a new path.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('./plan.js');

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// The first go is the plan; the rest correct for what x264 actually produced,
// which varies with how hard the footage is to compress.
const MAX_ATTEMPTS = 3;

/** A handle the caller can cancel through. */
function control() {
  return { child: null, cancelled: false, cancel() {
    this.cancelled = true;
    if (this.child) this.child.kill();
  } };
}

function run(bin, args, { onProgress, durationSec, ctl } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    if (ctl) ctl.child = child;
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (!onProgress || !durationSec) return;
      // -progress emits key=value lines, which beats scraping the banner.
      for (const line of String(chunk).split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / durationSec)));
      }
    });

    // Keep the tail only. A failing ffmpeg says why in the last few lines and
    // a working one can produce megabytes we would otherwise hold in memory.
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (ctl) ctl.child = null;
      if (ctl && ctl.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code !== 0) {
        const why = stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n');
        return reject(new Error(why || `ffmpeg exited with ${code}`));
      }
      resolve();
    });
  });
}

async function probe(ffprobe, file) {
  const json = await new Promise((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || 'Could not read that file'))));
  });

  const info = JSON.parse(json);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('There is no picture in that file');

  const durationSec = Number(info.format && info.format.duration) || 0;
  // A still is a video stream with no duration and a single frame.
  const still = !durationSec || video.nb_frames === '1' ||
    /^(image2|png_pipe|jpeg_pipe|webp_pipe)/.test(info.format.format_name || '');

  const [num, den] = String(video.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;

  return {
    kind: still ? 'image' : 'video',
    durationSec,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    hasAudio: Boolean(audio),
    bytes: fs.statSync(file).size,
  };
}

/*
 * Beside the original, never over it. The source is the one file here that
 * cannot be recreated, so it is never a candidate for the output path.
 */
function outputPath(source, ext, exists = fs.existsSync) {
  const dir = path.dirname(source);
  const base = path.basename(source, path.extname(source));
  let candidate = path.join(dir, `${base}-fits${ext}`);
  for (let n = 2; exists(candidate) && n < 1000; n++) {
    candidate = path.join(dir, `${base}-fits ${n}${ext}`);
  }
  return candidate;
}

async function fitVideo({ ffmpeg, file, info, targetBytes, outDir, onProgress = () => {}, ctl = control() }) {
  const out = outputPath(outDir ? path.join(outDir, path.basename(file)) : file, '.mp4');
  const logFile = path.join(os.tmpdir(), `justfits-${process.pid}-${Date.now()}`);
  let correction = 1;
  let result = null;

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const p = plan.planVideo({ ...info, targetBytes, correction });

      const filters = [];
      if (p.width !== info.width || p.height !== info.height) {
        filters.push(`scale=${p.width}:${p.height}:flags=lanczos`);
      }
      if (Math.abs(p.fps - info.fps) > 0.01) filters.push(`fps=${p.fps}`);

      const common = [
        '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
        '-i', file,
        '-c:v', 'libx264', '-b:v', `${p.videoKbps}k`,
        '-preset', 'slow', '-pix_fmt', 'yuv420p',
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-passlogfile', logFile,
      ];

      // Two passes, because hitting a size is precisely what two-pass is for.
      // The first sees the whole clip so the second can spend the budget
      // where the picture actually needs it.
      await run(ffmpeg, [...common, '-pass', '1', '-an', '-f', 'mp4', NULL_DEVICE], {
        durationSec: info.durationSec, ctl,
        onProgress: (v) => onProgress({ stage: 'Looking at the video', progress: v * 0.35, attempt }),
      });

      const audioArgs = p.audioKbps
        ? ['-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ac', String(p.audioChannels)]
        : ['-an'];

      await run(ffmpeg, [...common, '-pass', '2', ...audioArgs, '-movflags', '+faststart', out], {
        durationSec: info.durationSec, ctl,
        onProgress: (v) => onProgress({ stage: 'Compressing', progress: 0.35 + v * 0.65, attempt }),
      });

      const bytes = fs.statSync(out).size;
      result = { path: out, bytes, plan: p, attempts: attempt + 1 };
      if (bytes <= targetBytes) return result;

      // Overshot. Measure by how much and aim lower rather than guess again.
      correction = plan.correctionFor(bytes, targetBytes, correction);
    }
  } finally {
    for (const suffix of ['-0.log', '-0.log.mbtree', '.log', '.log.mbtree']) {
      try { fs.unlinkSync(logFile + suffix); } catch {}
    }
  }

  return { ...result, over: true };
}

async function fitImage({ ffmpeg, file, info, targetBytes, outDir, onProgress = () => {}, ctl = control() }) {
  const out = outputPath(outDir ? path.join(outDir, path.basename(file)) : file, '.jpg');
  let result = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const p = plan.planImage({ targetBytes, width: info.width, height: info.height, attempt });
    onProgress({ stage: attempt ? 'Trying harder' : 'Compressing', progress: attempt / 5, attempt });

    await run(ffmpeg, [
      '-hide_banner', '-nostats', '-y', '-i', file,
      '-vf', `scale=${p.width}:${p.height}:flags=lanczos`,
      '-q:v', String(p.quality), out,
    ], { ctl });

    const bytes = fs.statSync(out).size;
    result = { path: out, bytes, plan: p, attempts: attempt + 1 };
    if (bytes <= targetBytes) return result;
  }

  return { ...result, over: true };
}

module.exports = { control, probe, outputPath, fitVideo, fitImage, MAX_ATTEMPTS };
