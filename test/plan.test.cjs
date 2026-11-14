'use strict';

/*
 * The maths that decides whether a file fits.
 *
 *   node test/plan.test.cjs
 *
 * No framework. If it prints "ok" and exits 0, the arithmetic holds.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const plan = require('../src/plan.js');

const MB = plan.MB;

// What the planned bitrates would actually weigh, in bytes.
function weigh(p, durationSec) {
  return ((p.videoKbps + p.audioKbps) * 1000 * durationSec) / 8;
}

test('a plan lands under the target, not on it', () => {
  for (const seconds of [5, 30, 60, 300, 1800]) {
    const p = plan.planVideo({
      durationSec: seconds,
      targetBytes: 10 * MB,
      width: 1920,
      height: 1080,
      fps: 30,
    });
    assert.ok(weigh(p, seconds) < 10 * MB, `${seconds}s should fit`);
    assert.ok(weigh(p, seconds) > 10 * MB * 0.8, `${seconds}s should not waste the budget`);
  }
});

test('sound gives way before picture does', () => {
  const roomy = plan.planVideo({ durationSec: 20, targetBytes: 50 * MB, width: 1920, height: 1080, fps: 30 });
  const tight = plan.planVideo({ durationSec: 900, targetBytes: 10 * MB, width: 1920, height: 1080, fps: 30 });
  assert.equal(roomy.audioKbps, 128);
  assert.ok(tight.audioKbps <= 48, 'a long clip in a small target should shed audio bitrate');
  assert.equal(tight.audioChannels, 1, 'and drop to mono');
});

test('audio never eats the budget on a plan we call viable', () => {
  const p = plan.planVideo({ durationSec: 600, targetBytes: 10 * MB, width: 1280, height: 720, fps: 30 });
  assert.equal(p.hopeless, false);
  assert.ok(p.audioKbps <= (p.videoKbps + p.audioKbps) * 0.25 + 1);
});

test('a budget too small for sound and picture both is called hopeless', () => {
  // 16kbps is the floor worth encoding, so anything this tight cannot be
  // planned honestly. It must say so rather than silently spend the file
  // on audio and hand back a slideshow.
  const p = plan.planVideo({ durationSec: 600, targetBytes: 2 * MB, width: 1280, height: 720, fps: 30 });
  assert.equal(p.hopeless, true);
});

test('a silent clip spends everything on picture', () => {
  const p = plan.planVideo({ durationSec: 30, targetBytes: 10 * MB, hasAudio: false, width: 1920, height: 1080, fps: 30 });
  assert.equal(p.audioKbps, 0);
  assert.equal(p.audioChannels, 0);
});

test('a starved encode is scaled down rather than smeared', () => {
  const p = plan.planVideo({ durationSec: 600, targetBytes: 10 * MB, width: 1920, height: 1080, fps: 30 });
  assert.ok(p.height < 1080, 'ten minutes into 10MB cannot stay at 1080p');
  assert.ok(plan.bppFor(p.videoKbps, p.width, p.height, p.fps) >= 0.05 || p.rough);
});

test('a short clip in a big target keeps its resolution', () => {
  const p = plan.planVideo({ durationSec: 10, targetBytes: 500 * MB, width: 1920, height: 1080, fps: 30 });
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
});

test('nothing is ever upscaled', () => {
  const p = plan.planVideo({ durationSec: 3, targetBytes: 500 * MB, width: 640, height: 480, fps: 30 });
  assert.equal(p.width, 640);
  assert.equal(p.height, 480);
});

test('high frame rate is halved before resolution collapses', () => {
  const sixty = plan.planVideo({ durationSec: 120, targetBytes: 10 * MB, width: 1920, height: 1080, fps: 60 });
  assert.ok(sixty.fps <= 30, 'a starved 60fps clip should drop to 30');
});

test('portrait video steps down by its short edge', () => {
  const p = plan.planVideo({ durationSec: 300, targetBytes: 10 * MB, width: 1080, height: 1920, fps: 30 });
  assert.ok(p.width < p.height, 'still portrait');
  assert.ok(p.width <= 720, 'the short edge is what steps down');
});

test('dimensions stay even, because h264 demands it', () => {
  for (const [w, h] of [[1919, 1079], [1081, 1921], [641, 481]]) {
    const p = plan.planVideo({ durationSec: 240, targetBytes: 10 * MB, width: w, height: h, fps: 30 });
    assert.equal(p.width % 2, 0, `${w}x${h} width`);
    assert.equal(p.height % 2, 0, `${w}x${h} height`);
  }
});

test('an impossible ask is flagged rather than faked', () => {
  const p = plan.planVideo({ durationSec: 4 * 3600, targetBytes: 10 * MB, width: 1920, height: 1080, fps: 30 });
  assert.equal(p.hopeless, true);
  assert.ok(p.videoKbps > 0, 'still returns something encodable');
});

test('correction converges when the encoder overshoots', () => {
  const target = 10 * MB;
  let correction = 1;
  // Pretend the encoder always lands 18 percent over what was asked for.
  let actual = target * 1.18;
  for (let i = 0; i < 4 && actual > target; i++) {
    correction = plan.correctionFor(actual, target, correction);
    actual = target * 1.18 * correction;
  }
  assert.ok(actual < target, `should converge under target, landed at ${(actual / MB).toFixed(2)}MB`);
});

test('correction never chases upward', () => {
  const under = plan.correctionFor(1 * MB, 10 * MB, 1);
  assert.ok(under <= 1, 'an undershoot must not inflate the next attempt past the original plan');
});

test('bad input is refused rather than guessed at', () => {
  assert.throws(() => plan.planVideo({ durationSec: 0, targetBytes: 10 * MB, width: 100, height: 100 }));
  assert.throws(() => plan.planVideo({ durationSec: 10, targetBytes: 0, width: 100, height: 100 }));
});

test('image plans get progressively harsher', () => {
  const first = plan.planImage({ targetBytes: 1 * MB, width: 4000, height: 3000, attempt: 0 });
  const last = plan.planImage({ targetBytes: 1 * MB, width: 4000, height: 3000, attempt: 4 });
  assert.ok(last.quality > first.quality, 'quality number rises as quality falls');
  assert.ok(last.width < first.width, 'and the image shrinks');
  assert.equal(last.lastResort, true);
});

test('Windows device names are spotted in any case, with or without an extension', () => {
  for (const name of ['con', 'CON.mp4', 'nul.zip', 'Aux.tar.gz', 'com1.mp4', 'LPT9', 'nul. ', 'dir/prn.mp4', 'dir\\con.mp4']) {
    assert.equal(plan.isDeviceName(name), true, name);
  }
  for (const name of ['console.mp4', 'com0.mp4', 'com10.mp4', 'my-con.mp4', 'con/clip.mp4', '', null]) {
    assert.equal(plan.isDeviceName(name), false, String(name));
  }
});
