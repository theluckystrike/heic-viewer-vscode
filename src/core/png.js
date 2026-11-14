'use strict';
// Small PNG writer and reader (zlib from Node). Writer: RGBA8 or RGB8, filter chosen per row. Reader: every PNG color
// type and bit depth, Adam7 interlace, tRNS; 16-bit samples are reduced to 8 bits. Used by the Pro export and convert
// tools; nothing here touches the network or the file system.
const zlib = require('zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA8 to PNG bytes. opts.alpha: false writes RGB (default: RGB when every pixel is opaque). */
function encodePng(width, height, rgba, opts = {}) {
  let alpha = opts.alpha;
  if (alpha === undefined) { alpha = false; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { alpha = true; break; } }
  const ch = alpha ? 4 : 3;
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  const line = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) line[x * ch + c] = rgba[(y * width + x) * 4 + c];
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? line[i - ch] : 0, b = y ? prev[i] : 0, c = i >= ch && y ? prev[i - ch] : 0;
        let v;
        if (f === 0) v = line[i]; else if (f === 1) v = line[i] - a; else if (f === 2) v = line[i] - b; else if (f === 3) v = line[i] - ((a + b) >> 1);
        else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = line[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        o[i] = v & 255; sum += (o[i] < 128 ? o[i] : 256 - o[i]);
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
    line.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** PNG bytes to { width, height, rgba }. Throws on a broken file. */
function decodePng(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG file.');
  let p = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > buf.length) throw new Error('A PNG chunk runs past the end of the file.');
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('The PNG has no IHDR chunk.');
  const { w, h, depth, color, interlace } = ihdr;
  if (w * h > 16384 * 16384) throw new Error('The PNG is too large.');
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!chans) throw new Error(`PNG color type ${color} is not valid.`);
  const data = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (chans * depth) >> 3);
  const out = new Uint8Array(w * h * 4);
  let off = 0;
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const maxv = (1 << depth) - 1;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * chans * depth) / 8);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < ph; y++) {
      const f = data[off++];
      const line = Buffer.from(data.subarray(off, off + stride)); off += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        if (f === 1) line[i] = (line[i] + a) & 255; else if (f === 2) line[i] = (line[i] + b) & 255; else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      }
      const sample = (idx) => { // idx-th sample in the line
        if (depth === 8) return line[idx];
        if (depth === 16) return line[idx * 2];
        const bit = idx * depth; return (line[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
      };
      const sample16 = (idx) => (line[idx * 2] << 8) | line[idx * 2 + 1];
      for (let x = 0; x < pw; x++) {
        const d = (((y0 + y * dy) * w) + x0 + x * dx) * 4;
        const scale = (v) => (depth < 8 ? Math.round((v * 255) / maxv) : v);
        if (color === 3) {
          const k = sample(x);
          out[d] = plte ? plte[k * 3] : 0; out[d + 1] = plte ? plte[k * 3 + 1] : 0; out[d + 2] = plte ? plte[k * 3 + 2] : 0;
          out[d + 3] = trns && k < trns.length ? trns[k] : 255;
        } else if (color === 0) {
          const v = scale(sample(x)); out[d] = out[d + 1] = out[d + 2] = v;
          const raw = depth === 16 ? sample16(x) : sample(x);
          out[d + 3] = trns && trns.length >= 2 && raw === trns.readUInt16BE(0) ? 0 : 255;
        } else if (color === 4) { out[d] = out[d + 1] = out[d + 2] = sample(x * 2); out[d + 3] = sample(x * 2 + 1); }
        else if (color === 2) {
          out[d] = sample(x * 3); out[d + 1] = sample(x * 3 + 1); out[d + 2] = sample(x * 3 + 2);
          const t16 = trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
          const raw = depth === 16 ? [sample16(x * 3), sample16(x * 3 + 1), sample16(x * 3 + 2)] : [sample(x * 3), sample(x * 3 + 1), sample(x * 3 + 2)];
          out[d + 3] = t16 && raw[0] === t16[0] && raw[1] === t16[1] && raw[2] === t16[2] ? 0 : 255;
        } else { out[d] = sample(x * 4); out[d + 1] = sample(x * 4 + 1); out[d + 2] = sample(x * 4 + 2); out[d + 3] = sample(x * 4 + 3); }
      }
      prev = line;
    }
  }
  return { width: w, height: h, rgba: out };
}

module.exports = { encodePng, decodePng, isPng, crc32 };
