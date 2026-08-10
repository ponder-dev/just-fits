'use strict';

/*
 * The arithmetic that decides how to make a file fit.
 *
 * Pure functions. No ffmpeg, no filesystem, no Electron. Whether your video
 * comes in under the line is the one thing this app has to get right, so the
 * maths behind it is testable directly rather than trusted by eye.
 *
 * Everything here works in kbps and bytes. The caller turns the result into
 * ffmpeg arguments.
 */

// Decimal megabytes, not mebibytes. Services are vague about which they mean,
// and being wrong in this direction leaves us slightly under the limit rather
// than slightly over it, which is the only direction that matters.
const MB = 1000 * 1000;

/*
 * Where people actually get stuck, with the real numbers.
 *
 * Checked August 2026. They move, so they live in one list rather than
 * scattered through the app, and the custom box is always there for when a
 * platform changes its mind.
 */

// Email attachments are base64 encoded in transit, which inflates them by
// about 37 percent. A provider advertising 25MB will bounce a 25MB file, so
// the ones marked `encoded` aim at the size the file has to be before that
// happens rather than the number on the tin.
const BASE64 = 1.37;

const TARGETS = [
  { id: 'discord', group: 'Discord', label: 'Discord, free account', mb: 10,
    note: 'The usual one. A boosted server raises it for everyone in that server.' },
  { id: 'discord-basic', group: 'Discord', label: 'Discord Nitro Basic', mb: 50 },
  { id: 'discord-boost3', group: 'Discord', label: 'Discord, level 3 boosted server', mb: 100,
    note: 'Server boosts count even if you have no Nitro yourself.' },
  { id: 'discord-nitro', group: 'Discord', label: 'Discord Nitro', mb: 500 },

  { id: 'gmail', group: 'Email', label: 'Gmail', limitMb: 25, encoded: true },
  { id: 'outlook', group: 'Email', label: 'Outlook and Microsoft 365', limitMb: 20, encoded: true },

  { id: 'whatsapp', group: 'Messaging', label: 'WhatsApp video', mb: 16,
    note: 'Sending it as a document instead allows up to 2GB.' },
  { id: 'signal', group: 'Messaging', label: 'Signal', mb: 100 },
  { id: 'imessage', group: 'Messaging', label: 'iMessage', mb: 100 },
  { id: 'slack', group: 'Messaging', label: 'Slack', mb: 1000 },
  { id: 'telegram', group: 'Messaging', label: 'Telegram', mb: 2000 },
].map((t) => ({
  ...t,
  bytes: t.encoded ? Math.floor((t.limitMb * MB) / BASE64) : t.mb * MB,
  note: t.note || (t.encoded
    ? `${t.limitMb}MB limit, but base64 encoding adds about 37% in transit, so the file has to be smaller than that.`
    : ''),
}));

// mp4 spends a couple of percent on headers, indexes and muxing that the
// bitrate maths cannot see, and x264 does not hit a requested bitrate exactly.
// Aim under the line rather than at it.
const HEADROOM = 0.95;

/*
 * How much of the budget goes to sound.
 *
 * Speech stays intelligible far below the point where video falls apart, so
 * audio gives way first. The last two rungs are mono, because at that budget
 * one clean channel beats two muddy ones.
 */
const AUDIO_LADDER = [
  { from: 700, kbps: 128, channels: 2 },
  { from: 400, kbps: 96, channels: 2 },
  { from: 200, kbps: 64, channels: 2 },
  { from: 110, kbps: 48, channels: 1 },
  { from: 0, kbps: 32, channels: 1 },
];

// Ladder rungs are the short edge, so a portrait clip steps down the same way
// a landscape one does.
const SHORT_EDGES = [2160, 1440, 1080, 720, 540, 432, 360, 270];

// Bits per pixel per frame.
//
// 0.08 is the low end of what YouTube recommends for an upload at a given
// resolution, and it is the bar a rung has to clear to be chosen. It was 0.09
// at first, which pushed a 30 second 1080p clip into a 10MB target down to
// 540p when 720p had 2400kbps available: comfortably inside YouTube's own
// 2500-4000 range for 720p30. Below 0.05 h264 smears on anything that moves,
// so that is the point where a smaller frame genuinely does look better.
const GOOD_BPP = 0.08;
const MIN_BPP = 0.05;

// Under this there is no point pretending. The caller warns the user.
const FLOOR_KBPS = 60;

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Scale to a short edge, never upwards, always to even dimensions. */
function scaleToShortEdge(srcW, srcH, edge) {
  const src = Math.min(srcW, srcH);
  if (!src || edge >= src) return { width: even(srcW), height: even(srcH) };
  const k = edge / src;
  return { width: even(srcW * k), height: even(srcH * k) };
}

function audioFor(totalKbps, hasAudio) {
  if (!hasAudio) return { kbps: 0, channels: 0 };
  const rung = AUDIO_LADDER.find((r) => totalKbps >= r.from) || AUDIO_LADDER[AUDIO_LADDER.length - 1];
  // Never let sound eat more than a quarter of the budget. Below 16kbps AAC
  // is not worth encoding, so a budget that tight is hopeless anyway and
  // planVideo flags it as such rather than this quietly papering over it.
  const cap = Math.floor(totalKbps * 0.25);
  return { kbps: Math.max(16, Math.min(rung.kbps, cap)), channels: rung.channels };
}

function bppFor(videoKbps, width, height, fps) {
  return (videoKbps * 1000) / (width * height * fps);
}

/**
 * Pick the largest frame that still gets enough bits, dropping frame rate
 * before resolution gets silly.
 */
function pickFrame(videoKbps, srcW, srcH, srcFps) {
  const rates = srcFps > 32 ? [srcFps, 30] : [srcFps];
  const shortEdge = Math.min(srcW, srcH);
  // Leaving the source alone is always the first option. Without this a clip
  // whose height falls between two rungs gets shrunk for no reason at all.
  const rungs = [shortEdge, ...SHORT_EDGES.filter((e) => e < shortEdge)];

  for (const bar of [GOOD_BPP, MIN_BPP]) {
    for (const fps of rates) {
      for (const edge of rungs) {
        const { width, height } = scaleToShortEdge(srcW, srcH, edge);
        if (bppFor(videoKbps, width, height, fps) >= bar) {
          return { width, height, fps, rough: bar === MIN_BPP };
        }
      }
    }
  }

  // Nothing clears even the low bar. Take the smallest rung and be honest
  // about it rather than shipping a plan that pretends otherwise.
  const edge = rungs[rungs.length - 1];
  const { width, height } = scaleToShortEdge(srcW, srcH, edge);
  return { width, height, fps: Math.min(srcFps, 30), rough: true };
}

/**
 * Work out one encode.
 *
 * `correction` carries what the previous attempt actually produced, so a
 * second pass can aim lower without starting the reasoning again.
 */
function planVideo({ durationSec, targetBytes, hasAudio = true, width, height, fps = 30, correction = 1 }) {
  if (!(durationSec > 0)) throw new Error('Cannot plan an encode without a duration');
  if (!(targetBytes > 0)) throw new Error('Cannot plan an encode without a target size');

  const budgetBytes = targetBytes * HEADROOM * correction;
  const totalKbps = (budgetBytes * 8) / durationSec / 1000;

  const audio = audioFor(totalKbps, hasAudio);
  const videoKbps = Math.floor(totalKbps - audio.kbps);

  // Too long for the target at any quality worth producing.
  if (videoKbps < FLOOR_KBPS) {
    const frame = pickFrame(Math.max(videoKbps, 1), width, height, fps);
    return {
      videoKbps: Math.max(videoKbps, 20),
      audioKbps: audio.kbps,
      audioChannels: audio.channels,
      ...frame,
      rough: true,
      hopeless: true,
    };
  }

  const frame = pickFrame(videoKbps, width, height, fps);
  return {
    videoKbps,
    audioKbps: audio.kbps,
    audioChannels: audio.channels,
    ...frame,
    hopeless: false,
  };
}

/**
 * After an encode lands, how much to scale the next attempt by.
 *
 * x264 overshoots on hard content and undershoots on easy content, so rather
 * than guessing better we measure and correct. The extra 2 percent stops a
 * near miss from needing a third go.
 */
function correctionFor(actualBytes, targetBytes, previous = 1) {
  if (!(actualBytes > 0)) return previous;
  const next = previous * (targetBytes / actualBytes) * 0.98;
  // Never chase below a tenth of the original guess: something else is wrong.
  return Math.max(0.1, Math.min(next, previous));
}

/** A still image, where quality is a dial rather than a bitrate. */
function planImage({ targetBytes, width, height, attempt = 0 }) {
  // JPEG quality in ffmpeg's -q:v scale, where 2 is best and 31 is worst.
  const quality = [3, 6, 10, 16, 24][Math.min(attempt, 4)];
  const shrink = [1, 1, 0.8, 0.6, 0.45][Math.min(attempt, 4)];
  return {
    quality,
    width: even(width * shrink),
    height: even(height * shrink),
    lastResort: attempt >= 4,
    targetBytes,
  };
}

module.exports = {
  MB,
  BASE64,
  TARGETS,
  HEADROOM,
  planVideo,
  planImage,
  correctionFor,
  scaleToShortEdge,
  audioFor,
  bppFor,
};
