// Generates build/icon.svg.
//
// Three things macOS cares about:
//
//   1. Size. An app icon is drawn at about 824x824 inside a 1024x1024 canvas.
//      Filling the whole canvas makes it look oversized in the Dock.
//   2. Shape. The corners are a superellipse, not a circular arc. A rounded
//      rect reads as subtly wrong beside real Mac icons.
//   3. It has to survive 16 pixels, so every shape is fat and there are four
//      of them at most.
//
// A hydraulic press coming down into a box. Two earlier attempts borrowed
// symbols that already meant something else: two triangles either side of a
// bar is the skip-track glyph every media player uses, and a play mark inside
// a frame is a video player. A press is nobody else's, and it says what the
// app does without needing to be explained.
//
//   node scripts/make-icon.mjs && npx electron scripts/icons.cjs && ./scripts/make-icns.sh

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANVAS = 1024;
const ART = 824;
const N = 5;

/** Superellipse |x/a|^n + |y/b|^n = 1, sampled densely enough to look smooth. */
function squirclePath(cx, cy, radius, exponent, steps = 720) {
  const points = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = cx + radius * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = cy + radius * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

/** A block with its sides bulging, which is what being squashed looks like. */
function squashed(top, bottom, left, right, bulge) {
  const mid = (top + bottom) / 2;
  return `M${left} ${top} L${right} ${top} Q${right + bulge} ${mid} ${right} ${bottom} ` +
         `L${left} ${bottom} Q${left - bulge} ${mid} ${left} ${top} Z`;
}

// An open topped container. The ram is narrower than its mouth, so the picture
// is a press coming down into the box rather than resting on top of it.
const BOX = 'M232 511 L232 703 Q232 763 292 763 L732 763 Q792 763 792 703 ' +
            'L792 511 L692 511 L692 663 L332 663 L332 511 Z';

/*
 * The house gradient, shared with the mark and every other tool icon, and the
 * same slate and highlight the other two use for their objects.
 *
 * Just JPEG is a white photo card with a yellow sun, SubSmash is a dark slate
 * clapper with a yellow bar. Both are objects with weight and more than one
 * color. A flat white pictogram sat next to them looks like a system glyph
 * that wandered in, which is what the first version of this was.
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#6d8bff"/>
      <stop offset="1" stop-color="#8a5cf6"/>
    </linearGradient>
    <!-- Three materials, so the picture has parts rather than a silhouette:
         the silver press that moves, the yellow block being squashed, and the
         dark bed it is being squashed into. -->
    <linearGradient id="steel" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#f2f4f8"/>
      <stop offset="0.55" stop-color="#c8cdd8"/>
      <stop offset="1" stop-color="#9aa2b4"/>
    </linearGradient>
    <linearGradient id="slate" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#3a3a47"/>
      <stop offset="1" stop-color="#1b1b24"/>
    </linearGradient>
    <linearGradient id="block" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#ffd166"/>
      <stop offset="1" stop-color="#f0a93c"/>
    </linearGradient>
  </defs>

  <path d="${squirclePath(CANVAS / 2, CANVAS / 2, ART / 2, N)}" fill="url(#bg)"/>

  <!-- The dark bed, then the block sitting in it, then the silver press on
       top of both. Drawn in that order so the press reads as the thing coming
       down and the block as the thing underneath. -->
  <path d="${BOX}" fill="url(#slate)"/>
  <path d="${squashed(559, 663, 372, 652, 38)}" fill="url(#block)"/>

  <g fill="url(#steel)">
    <rect x="466" y="261" width="92" height="180" rx="22"/>
    <rect x="352" y="431" width="320" height="92" rx="30"/>
  </g>

  <!-- A lit top edge on the ram and the plate, so the metal has a direction of
       light rather than sitting flat. White on silver, so it is a highlight
       rather than the whole shape. -->
  <g fill="#ffffff" fill-opacity="0.75">
    <rect x="466" y="261" width="92" height="22" rx="11"/>
    <rect x="352" y="431" width="320" height="20" rx="10"/>
  </g>

  <!-- A shadow line under the plate, which is what makes it read as a slab
       with thickness pressing down rather than a flat bar. -->
  <rect x="352" y="505" width="320" height="18" rx="9" fill="#5c6478" fill-opacity="0.5"/>
</svg>
`;

await fs.mkdir(path.join(root, 'build'), { recursive: true });
await fs.writeFile(path.join(root, 'build/icon.svg'), svg);
console.log('build/icon.svg written');
