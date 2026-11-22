'use strict';

/*
 * The turn a phone HEIC carries only in its EXIF.
 *
 * Most phones store a portrait photo as a landscape picture with a rotation
 * box (irot) that ffmpeg applies by itself. Some (an iPhone 7, for one) write
 * no box and only set the Orientation tag in the EXIF item, which ffmpeg
 * ignores for HEIC, so the photo came out on its side. This reads that tag
 * straight from the file's boxes. It answers 1 (no turn) whenever the file has
 * a rotation or mirror box, because ffmpeg has already applied that one and
 * turning again would put the picture on its side the other way.
 */

const fs = require('node:fs');

const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le) => (le
  ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
  : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p, false);
    const type = b.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = u32(b, p + 12, false);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;
    yield { type, body: p + header, end: p + size };
    p += size;
  }
}

function findBox(b, start, end, names) {
  const [head, ...rest] = names;
  for (const box of boxes(b, start, end)) {
    if (box.type !== head) continue;
    const body = head === 'meta' ? box.body + 4 : box.body; // meta is a FullBox
    return rest.length ? findBox(b, body, box.end, rest) : { ...box, body };
  }
  return null;
}

function exifItemId(b, iinf) {
  const version = b[iinf.body];
  let p = iinf.body + 4;
  p += version === 0 ? 2 : 4;
  for (const box of boxes(b, p, iinf.end)) {
    if (box.type !== 'infe') continue;
    const v = b[box.body];
    if (v < 2) continue;
    let q = box.body + 4;
    let id;
    if (v === 2) { id = u16(b, q, false); q += 2; } else { id = u32(b, q, false); q += 4; }
    q += 2;
    if (b.toString('latin1', q, q + 4) === 'Exif') return id;
  }
  return null;
}

function itemRange(b, iloc, wanted) {
  const version = b[iloc.body];
  let p = iloc.body + 4;
  const offsetSize = b[p] >> 4;
  const lengthSize = b[p] & 0x0f;
  const baseSize = b[p + 1] >> 4;
  const indexSize = b[p + 1] & 0x0f;
  p += 2;
  let count;
  if (version < 2) { count = u16(b, p, false); p += 2; } else { count = u32(b, p, false); p += 4; }
  const sized = (at, size) => (size === 4 ? u32(b, at, false) : size === 8 ? u32(b, at + 4, false) : size === 2 ? u16(b, at, false) : 0);

  for (let i = 0; i < count; i++) {
    let id;
    if (version < 2) { id = u16(b, p, false); p += 2; } else { id = u32(b, p, false); p += 4; }
    if (version === 1 || version === 2) p += 2;
    p += 2;
    const base = sized(p, baseSize); p += baseSize;
    const extents = u16(b, p, false); p += 2;
    for (let e = 0; e < extents; e++) {
      if ((version === 1 || version === 2) && indexSize) p += indexSize;
      const off = sized(p, offsetSize); p += offsetSize;
      const len = sized(p, lengthSize); p += lengthSize;
      if (id === wanted) return { offset: base + off, length: len };
    }
  }
  return null;
}

function tiffOrientation(t) {
  if (t.length < 8) return 1;
  const le = u16(t, 0, false) === 0x4949;
  const ifd = u32(t, 4, le);
  if (ifd + 2 > t.length) return 1;
  const count = u16(t, ifd, le);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(t, e, le) === 0x0112) {
      const v = u16(t, e + 8, le);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** The EXIF orientation (1..8) a HEIC file leaves for the viewer to apply; 1 when none, or when a box already carries the turn. */
function heifOrientation(file) {
  try {
    const fd = fs.openSync(file, 'r');
    let head;
    try {
      head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      // Only an ISO base media file with a heif-family brand; anything else is none of our business.
      if (head.toString('latin1', 4, 8) !== 'ftyp' || !/^(hei|hev|mif|msf)/.test(head.toString('latin1', 8, 12))) return 1;
    } finally { fs.closeSync(fd); }
    const b = fs.readFileSync(file);
    const ipco = findBox(b, 0, b.length, ['meta', 'iprp', 'ipco']);
    if (ipco) {
      for (const box of boxes(b, ipco.body, ipco.end)) if (box.type === 'irot' || box.type === 'imir') return 1;
    }
    const iinf = findBox(b, 0, b.length, ['meta', 'iinf']);
    const iloc = findBox(b, 0, b.length, ['meta', 'iloc']);
    if (!iinf || !iloc) return 1;
    const id = exifItemId(b, iinf);
    if (id == null) return 1;
    const loc = itemRange(b, iloc, id);
    if (!loc || loc.offset + loc.length > b.length) return 1;
    const payload = b.subarray(loc.offset, loc.offset + loc.length);
    // The item starts with a 4-byte offset to the TIFF header (usually 6, past "Exif\0\0").
    const at = 4 + (payload.length >= 4 ? u32(payload, 0, false) : 0);
    const t = payload.subarray(at);
    if (t.length >= 4 && ((t[0] === 0x49 && t[1] === 0x49) || (t[0] === 0x4d && t[1] === 0x4d))) return tiffOrientation(t);
    return 1;
  } catch {
    return 1;
  }
}

/** The ffmpeg filters that turn pixels upright for an EXIF orientation. */
function orientationFilters(o) {
  return ({
    2: ['hflip'], 3: ['hflip', 'vflip'], 4: ['vflip'],
    5: ['transpose=0'], 6: ['transpose=1'], 7: ['transpose=3'], 8: ['transpose=2'],
  })[o] || [];
}

module.exports = { heifOrientation, orientationFilters };
