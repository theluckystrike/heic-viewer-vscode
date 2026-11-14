'use strict';
// Worker thread that decodes HEIC (HEVC) images with libheif (lib/libheif, LGPL-3.0, loaded as a separate WASM file).
// Runs off the extension host thread so a 45-megapixel photo never freezes VS Code. The parent ends the worker when
// it has been idle for a while, which also frees the WASM memory. No network: the WASM bytes are read from disk.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

let lib = null;
let lastLog = '';
// libheif writes its errors with console.log; keep the last one as the reason instead of printing it.
const keep = (...a) => { lastLog = a.map((x) => (x && typeof x === 'object' ? x.message || '' : String(x))).filter(Boolean).join(' '); };
console.log = keep; console.warn = keep; console.error = keep;

function load() {
  if (!lib) {
    const dir = path.join(__dirname, '..', '..', 'lib', 'libheif');
    lib = require(path.join(dir, 'libheif.js'))({ wasmBinary: fs.readFileSync(path.join(dir, 'libheif.wasm')) });
  }
  return lib;
}

/** Box-filter downscale of RGBA so the longer side is at most max (for thumbnails). */
function shrink(rgba, w, h, max) {
  const s = Math.max(w, h) / max;
  if (!(s > 1)) return { rgba, width: w, height: h };
  const W = Math.max(1, Math.round(w / s)), H = Math.max(1, Math.round(h / s));
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) { const i = (yy * w + xx) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++; }
      }
      const o = (y * W + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { rgba: out, width: W, height: H };
}

async function decode(m) {
  const L = load();
  lastLog = '';
  const dec = new L.HeifDecoder();
  const handles = dec.decode(m.bytes);
  try {
    if (!handles.length) throw new Error(lastLog || 'libheif found no image it can read in this file.');
    const ids = L.heif_js_context_get_list_of_top_level_image_IDs(dec.decoder) || [];
    let idx = typeof m.itemId === 'number' && m.itemId > 0 ? Array.from(ids).indexOf(m.itemId) : -1;
    if (idx < 0) idx = Math.min(Math.max(0, m.index | 0), handles.length - 1);
    const h = handles[idx];
    const img = await L.heif_js_decode_image2(h.handle, L.heif_colorspace.heif_colorspace_RGB, L.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!img || img.code) throw new Error((img && img.message) || lastLog || 'libheif could not decode this image.');
    let out = null;
    try {
      for (const ch of img.channels) {
        if (ch.id !== L.heif_channel.heif_channel_interleaved) continue;
        const w = ch.width, hh = ch.height;
        const rgba = new Uint8ClampedArray(w * hh * 4);
        if (ch.stride === w * 4) rgba.set(ch.data.subarray ? ch.data.subarray(0, w * hh * 4) : ch.data);
        else for (let y = 0; y < hh; y++) rgba.set(ch.data.subarray(y * ch.stride, y * ch.stride + w * 4), y * w * 4);
        out = { width: w, height: hh, rgba };
      }
    } finally { L.heif_image_release(img.image); }
    if (!out) throw new Error('libheif returned no RGBA plane.');
    if (m.maxSide) out = shrink(out.rgba, out.width, out.height, m.maxSide);
    return { width: out.width, height: out.height, rgba: out.rgba, count: handles.length, ids: Array.from(ids), index: idx };
  } finally {
    for (const h of handles) { try { h.free(); } catch (e) { /* already freed */ } }
    try { if (dec.decoder) { L.heif_context_free(dec.decoder); dec.decoder = null; } } catch (e) { /* ignore */ }
  }
}

parentPort.on('message', async (m) => {
  try {
    const r = await decode(m);
    parentPort.postMessage({ seq: m.seq, ok: true, ...r }, [r.rgba.buffer]);
  } catch (e) {
    parentPort.postMessage({ seq: m.seq, ok: false, error: String((e && e.message) || e) });
  }
});
