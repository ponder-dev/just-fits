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

function ffprobeOut(ffprobe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    // ffprobe's own lines carry a demuxer tag and a memory address
    // ("[mov,mp4,... @ 0x1234] moov atom not found"), which changes every run
    // and means nothing to a person or a script; the line after it says why.
    const reason = () => err.split('\n').map((l) => l.trim())
      .filter((l) => l && !/^\[[^\]]* @ 0x[0-9a-f]+\]/i.test(l)).pop();
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(reason() || 'Could not read that file'))));
  });
}

// "00:01:02.500000000", as Matroska writes its DURATION tag.
function clockSeconds(value) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// The last packet's timestamp. Only reached for files whose header carries no
// duration at all (a webm recorded live by a browser), so the cost of reading
// every packet header is paid only when there is no other way to know.
async function scanDuration(ffprobe, file) {
  try {
    const packets = await ffprobeOut(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file]);
    let last = 0;
    for (const line of packets.split('\n')) {
      const t = Number(line.split(',')[0]);
      if (Number.isFinite(t) && t > last) last = t;
    }
    return last;
  } catch {
    return 0;
  }
}

async function probe(ffprobe, file) {
  const json = await ffprobeOut(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);

  const info = JSON.parse(json);
  const streams = info.streams || [];
  // Cover art in an mp3 or m4a is a video stream too, but it is not the
  // picture anyone means to send, so it never counts as one.
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('There is no picture in that file');

  const imageFormat = /^(image2|png_pipe|jpeg_pipe|webp_pipe)/.test((info.format && info.format.format_name) || '');
  let durationSec = Number(info.format && info.format.duration) ||
    Number(video.duration) ||
    clockSeconds(video.tags && (video.tags.DURATION || video.tags.duration)) || 0;
  // No duration in the header does not make a video a still: a live-recorded
  // webm has none, and treating it as an image turned it into one JPEG frame.
  if (!durationSec && !imageFormat && video.nb_frames !== '1') {
    durationSec = await scanDuration(ffprobe, file);
  }
  // A still is a video stream with no duration and a single frame.
  const still = !durationSec || video.nb_frames === '1' || imageFormat;

  // Phones store portrait video landscape with a rotation flag, and ffmpeg
  // rotates before the scale filter runs, so plan in the shape that is shown
  // or a portrait clip gets squashed into a landscape frame.
  const sideRotation = (video.side_data_list || []).find((d) => d.rotation !== undefined);
  const rotation = Number(sideRotation ? sideRotation.rotation : (video.tags && video.tags.rotate)) || 0;
  const sideways = Math.abs(Math.round(rotation)) % 180 === 90;

  const [num, den] = String(video.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;

  return {
    kind: still ? 'image' : 'video',
    durationSec,
    width: Number(sideways ? video.height : video.width) || 0,
    height: Number(sideways ? video.width : video.height) || 0,
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
  let lastPlan = null;

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const p = plan.planVideo({ ...info, targetBytes, correction });
      // At the floors a smaller correction changes nothing, and encoding the
      // same plan again only repeats a slow two-pass for the same result.
      const key = [p.width, p.height, p.fps, p.videoKbps, p.audioKbps, p.audioChannels].join(',');
      if (key === lastPlan) break;
      lastPlan = key;

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
  } catch (err) {
    // A cancelled or failed encode leaves a half-written file under a name
    // that says it fits. Nothing should be left that looks sendable.
    try { fs.unlinkSync(out); } catch {}
    // Fedora's default ffmpeg and other LGPL builds have no x264, and ffmpeg's
    // own wording for that does not say what to do about it.
    if (/Unknown encoder 'libx264'/.test(err.message) && !err.cancelled) {
      throw new Error(`This ffmpeg has no H.264 encoder (libx264), which video needs. Install a full ffmpeg build.\n${err.message}`);
    }
    throw err;
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

    try {
      await run(ffmpeg, [
        '-hide_banner', '-nostats', '-y', '-i', file,
        '-vf', `scale=${p.width}:${p.height}:flags=lanczos`,
        '-q:v', String(p.quality), out,
      ], { ctl });
    } catch (err) {
      // Same as video: no half-written file left behind under a "fits" name.
      try { fs.unlinkSync(out); } catch {}
      throw err;
    }

    const bytes = fs.statSync(out).size;
    result = { path: out, bytes, plan: p, attempts: attempt + 1 };
    if (bytes <= targetBytes) return result;
  }

  return { ...result, over: true };
}

module.exports = { control, probe, outputPath, fitVideo, fitImage, MAX_ATTEMPTS };
