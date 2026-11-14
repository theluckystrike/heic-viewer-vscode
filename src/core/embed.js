'use strict';
// Puts an EXIF block into a freshly encoded JPEG, PNG or WebP file (the webview's encoder writes none). The EXIF is a
// copy of the source photo's TIFF block, with Orientation set to 1 because the pixels are already turned upright, and
// with GPS, serial numbers and owner names removed when the user asked for that.
const X = require('./exif');

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/**
 * The EXIF block to write for mode 'keep' (all but the position-revealing parts stay), 'nogps' (GPS, serials and
 * owner removed) or 'none'. Returns a fresh Buffer or null.
 */
function exifForOutput(tiff, mode) {
  if (!tiff || mode === 'none') return null;
  const copy = Buffer.from(tiff);
  X.setOrientation(copy, 1);
  if (mode === 'nogps') X.stripTiff(copy, { gps: true, serials: true, owner: true });
  return copy;
}

function jpegWithExif(jpeg, tiff) {
  const j = Buffer.from(jpeg);
  if (!tiff) return j;
  if (j[0] !== 0xff || j[1] !== 0xd8) throw new Error('Not a JPEG file.');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff)]);
  if (payload.length + 2 > 0xffff) return j; // too big for one APP1 segment: write no EXIF
  // After SOI and an APP0 (JFIF) segment when there is one; drop any APP1 Exif the encoder wrote.
  let o = 2;
  const keep = [j.subarray(0, 2)];
  if (j[o] === 0xff && j[o + 1] === 0xe0) { const len = j.readUInt16BE(o + 2); keep.push(j.subarray(o, o + 2 + len)); o += 2 + len; }
  while (j[o] === 0xff && j[o + 1] === 0xe1) { const len = j.readUInt16BE(o + 2); o += 2 + len; }
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([...keep, seg, payload, j.subarray(o)]);
}

function pngWithExif(png, tiff) {
  const p = Buffer.from(png);
  if (!tiff) return p;
  if (p.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.');
  let o = 8;
  while (o + 8 <= p.length) {
    const len = p.readUInt32BE(o), type = p.toString('latin1', o + 4, o + 8);
    if (type === 'IDAT') break;
    o += 12 + len;
  }
  const data = Buffer.from(tiff);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('eXIf', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return Buffer.concat([p.subarray(0, o), chunk, p.subarray(o)]);
}

function riffChunks(w) {
  const out = [];
  let o = 12;
  while (o + 8 <= w.length) {
    const type = w.toString('latin1', o, o + 4), len = w.readUInt32LE(o + 4);
    out.push({ type, data: w.subarray(o + 8, o + 8 + len) });
    o += 8 + len + (len & 1);
  }
  return out;
}
function chunk(type, data) {
  const pad = data.length & 1;
  const b = Buffer.alloc(8 + data.length + pad);
  b.write(type, 0, 'latin1'); b.writeUInt32LE(data.length, 4); Buffer.from(data).copy(b, 8);
  return b;
}

/** Adds an EXIF chunk to a WebP, turning a simple VP8 or VP8L file into the extended (VP8X) layout. */
function webpWithExif(webp, tiff, width, height) {
  const w = Buffer.from(webp);
  if (!tiff) return w;
  if (w.toString('latin1', 0, 4) !== 'RIFF' || w.toString('latin1', 8, 12) !== 'WEBP') throw new Error('Not a WebP file.');
  const chunks = riffChunks(w).filter((c) => c.type !== 'EXIF');
  let vp8x = chunks.find((c) => c.type === 'VP8X');
  const body = [];
  if (vp8x) {
    const d = Buffer.from(vp8x.data); d[0] |= 0x08;
    for (const c of chunks) body.push(c.type === 'VP8X' ? chunk('VP8X', d) : chunk(c.type, c.data));
  } else {
    const d = Buffer.alloc(10);
    const vp8l = chunks.find((c) => c.type === 'VP8L');
    const alpha = !!(vp8l && vp8l.data.length > 4 && (vp8l.data[4] & 0x10));
    d[0] = 0x08 | (alpha ? 0x10 : 0);
    d.writeUIntLE(width - 1, 4, 3); d.writeUIntLE(height - 1, 7, 3);
    body.push(chunk('VP8X', d));
    for (const c of chunks) body.push(chunk(c.type, c.data));
  }
  body.push(chunk('EXIF', Buffer.from(tiff)));
  const all = Buffer.concat(body);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(all.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, all]);
}

/** Embeds `tiff` into encoded bytes of `format` ('jpeg' | 'png' | 'webp'). */
function withExif(format, bytes, tiff, width, height) {
  if (!tiff) return Buffer.from(bytes);
  if (format === 'jpeg') return jpegWithExif(bytes, tiff);
  if (format === 'png') return pngWithExif(bytes, tiff);
  if (format === 'webp') return webpWithExif(bytes, tiff, width, height);
  return Buffer.from(bytes);
}

/** Reads the EXIF TIFF block back from a JPEG, PNG or WebP (for tests and the report). */
function readBackExif(bytes) {
  const b = Buffer.from(bytes);
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const m = b[o + 1], len = b.readUInt16BE(o + 2);
      if (m === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') return b.subarray(o + 10, o + 2 + len);
      if (m === 0xda) break;
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) {
    let o = 8;
    while (o + 8 <= b.length) { const len = b.readUInt32BE(o), t = b.toString('latin1', o + 4, o + 8); if (t === 'eXIf') return b.subarray(o + 8, o + 8 + len); o += 12 + len; }
    return null;
  }
  if (b.toString('latin1', 0, 4) === 'RIFF') { const c = riffChunks(b).find((x) => x.type === 'EXIF'); return c ? c.data : null; }
  return null;
}

module.exports = { exifForOutput, jpegWithExif, pngWithExif, webpWithExif, withExif, readBackExif, crc32 };
