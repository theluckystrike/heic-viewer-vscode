'use strict';
// HEIF and AVIF container reader (ISO/IEC 23008-12 on top of ISO BMFF). Pure JavaScript, no dependencies.
// Reads the file type, the item list (iinf, iloc, iref, pitm), the item properties (ispe, pixi, colr, hvcC, av1C,
// irot, imir, clap, auxC) and the image sequence track flag. It never decodes pixels: src/core/decoder.js does that
// for HEVC with libheif, and the webview does it for AV1 with the editor's own image decoder.

const IMAGE_TYPES = new Set(['hvc1', 'av01', 'grid', 'iden', 'iovl', 'jpeg', 'vvc1', 'avc1', 'unci', 'j2k1', 'tmap', 'evc1']);
const CODEC_NAMES = {
  hvc1: 'HEVC (H.265)', av01: 'AV1', grid: 'Grid of tiles', iden: 'Derived (identity)', iovl: 'Overlay', jpeg: 'JPEG',
  vvc1: 'VVC (H.266)', avc1: 'AVC (H.264)', unci: 'Uncompressed', j2k1: 'JPEG 2000', tmap: 'Tone map (HDR gain map)', evc1: 'EVC',
};
const HEVC_PROFILES = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range Extensions' };
const AV1_PROFILES = { 0: 'Main', 1: 'High', 2: 'Professional' };
const PRIMARIES = { 1: 'BT.709 / sRGB', 9: 'BT.2020', 11: 'DCI-P3', 12: 'Display P3', 2: 'unspecified' };
const TRANSFERS = { 1: 'BT.709', 13: 'sRGB', 16: 'PQ (HDR)', 18: 'HLG (HDR)', 8: 'linear', 2: 'unspecified', 6: 'BT.601', 14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit' };

class Reader {
  constructor(buf) { this.b = buf; }
  u8(o) { return this.b[o]; }
  u16(o) { return (this.b[o] << 8) | this.b[o + 1]; }
  u32(o) { return ((this.b[o] << 24) >>> 0) + (this.b[o + 1] << 16) + (this.b[o + 2] << 8) + this.b[o + 3]; }
  u64(o) { return this.u32(o) * 4294967296 + this.u32(o + 4); }
  uN(o, n) { return n === 0 ? 0 : n === 1 ? this.u8(o) : n === 2 ? this.u16(o) : n === 4 ? this.u32(o) : n === 8 ? this.u64(o) : NaN; }
  fourcc(o) { return String.fromCharCode(this.b[o], this.b[o + 1], this.b[o + 2], this.b[o + 3]); }
  cstr(o, end) { let e = o; while (e < end && this.b[e] !== 0) e++; return { s: Buffer.from(this.b.subarray(o, e)).toString('utf8'), next: Math.min(end, e + 1) }; }
}

/** Child boxes of [start, end). Each: { type, start (header), data (payload start), end }. Throws on a broken size. */
function boxes(r, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = r.u32(o);
    const type = r.fourcc(o + 4);
    let data = o + 8;
    if (size === 1) { if (o + 16 > end) throw new Error(`The "${type}" box at byte ${o} is cut off.`); size = r.u64(o + 8); data = o + 16; } else if (size === 0) size = end - o;
    if (type === 'uuid') data += 16;
    if (size < data - o || o + size > end) throw new Error(`The "${type}" box at byte ${o} says it is ${size} bytes long, but the file ends at byte ${end}.`);
    out.push({ type, start: o, data, end: o + size });
    o += size;
  }
  return out;
}

function parseIloc(r, b) {
  const v = r.u8(b.data);
  let o = b.data + 4;
  const a = r.u8(o), c = r.u8(o + 1);
  const offSize = a >> 4, lenSize = a & 15, baseSize = c >> 4, idxSize = v >= 1 ? c & 15 : 0;
  o += 2;
  const count = v < 2 ? r.u16(o) : r.u32(o);
  o += v < 2 ? 2 : 4;
  const map = new Map();
  for (let i = 0; i < count && o < b.end; i++) {
    const id = v < 2 ? r.u16(o) : r.u32(o);
    o += v < 2 ? 2 : 4;
    let method = 0;
    if (v >= 1) { method = r.u16(o) & 15; o += 2; }
    o += 2; // data_reference_index
    const base = r.uN(o, baseSize); o += baseSize;
    const n = r.u16(o); o += 2;
    const extents = [];
    for (let k = 0; k < n; k++) {
      if (idxSize) o += idxSize;
      const off = r.uN(o, offSize); o += offSize;
      const len = r.uN(o, lenSize); o += lenSize;
      extents.push({ offset: base + off, length: len });
    }
    map.set(id, { method, extents });
  }
  return map;
}

function parseIinf(r, b) {
  const v = r.u8(b.data);
  const off = b.data + 4 + (v === 0 ? 2 : 4);
  const items = [];
  for (const e of boxes(r, off, b.end)) {
    if (e.type !== 'infe') continue;
    const iv = r.u8(e.data);
    const flags = r.u32(e.data) & 0xffffff;
    let o = e.data + 4;
    if (iv < 2) { // old style: no item type
      const id = r.u16(o);
      const name = r.cstr(o + 4, e.end);
      items.push({ id, type: '', name: name.s, hidden: !!(flags & 1) });
      continue;
    }
    const id = iv === 2 ? r.u16(o) : r.u32(o);
    o += iv === 2 ? 2 : 4;
    o += 2; // protection index
    const type = r.fourcc(o); o += 4;
    const name = r.cstr(o, e.end);
    const it = { id, type, name: name.s, hidden: !!(flags & 1) };
    if (type === 'mime') { const ct = r.cstr(name.next, e.end); it.contentType = ct.s; }
    items.push(it);
  }
  return items;
}

function parseIref(r, b) {
  const v = r.u8(b.data);
  const refs = [];
  for (const e of boxes(r, b.data + 4, b.end)) {
    let o = e.data;
    const from = v === 0 ? r.u16(o) : r.u32(o); o += v === 0 ? 2 : 4;
    const n = r.u16(o); o += 2;
    const to = [];
    for (let i = 0; i < n && o < e.end; i++) { to.push(v === 0 ? r.u16(o) : r.u32(o)); o += v === 0 ? 2 : 4; }
    refs.push({ type: e.type, from, to });
  }
  return refs;
}

function iccDescription(r, start, end) {
  // ICC profile: tag table at 128; 'desc' tag is either 'desc' (v2, ASCII) or 'mluc' (v4, UTF-16BE).
  try {
    const n = r.u32(start + 128);
    for (let i = 0; i < n && i < 200; i++) {
      const t = start + 132 + i * 12;
      if (r.fourcc(t) !== 'desc') continue;
      const off = start + r.u32(t + 4), len = r.u32(t + 8);
      if (off + len > end) return '';
      const kind = r.fourcc(off);
      if (kind === 'desc') { const l = r.u32(off + 8); return Buffer.from(r.b.subarray(off + 12, off + 12 + Math.max(0, l - 1))).toString('latin1').trim(); }
      if (kind === 'mluc') {
        const so = off + r.u32(off + 16 + 8) , sl = r.u32(off + 16 + 4);
        const bytes = Buffer.from(r.b.subarray(so, so + sl));
        let s = '';
        for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode(bytes.readUInt16BE(k));
        return s.replace(/\0+$/, '').trim();
      }
    }
  } catch (e) { /* unreadable profile: no name */ }
  return '';
}

function parseProperty(r, p) {
  const d = p.data;
  switch (p.type) {
    case 'ispe': return { type: 'ispe', width: r.u32(d + 4), height: r.u32(d + 8) };
    case 'pixi': { const n = r.u8(d + 4); const bits = []; for (let i = 0; i < n; i++) bits.push(r.u8(d + 5 + i)); return { type: 'pixi', channels: n, bits }; }
    case 'irot': return { type: 'irot', angle: (r.u8(d) & 3) * 90 };
    case 'imir': return { type: 'imir', axis: r.u8(d) & 1 };
    case 'clap': {
      const s = (o) => r.u32(o) | 0;
      return { type: 'clap', width: s(d) / (s(d + 4) || 1), height: s(d + 8) / (s(d + 12) || 1) };
    }
    case 'colr': {
      const kind = r.fourcc(d);
      if (kind === 'nclx') return { type: 'colr', kind, primaries: r.u16(d + 4), transfer: r.u16(d + 6), matrix: r.u16(d + 8), fullRange: !!(r.u8(d + 10) & 0x80) };
      if (kind === 'prof' || kind === 'rICC') return { type: 'colr', kind, iccBytes: p.end - d - 4, iccName: iccDescription(r, d + 4, p.end) };
      return { type: 'colr', kind };
    }
    case 'hvcC': {
      const pb = r.u8(d + 1);
      return { type: 'hvcC', profile: pb & 31, tier: (pb >> 5) & 1, level: r.u8(d + 12), chroma: r.u8(d + 16) & 3, bitDepth: (r.u8(d + 17) & 7) + 8, bitDepthChroma: (r.u8(d + 18) & 7) + 8 };
    }
    case 'av1C': {
      const b1 = r.u8(d + 1), b2 = r.u8(d + 2);
      const high = !!(b2 & 0x40), twelve = !!(b2 & 0x20), mono = !!(b2 & 0x10), sx = (b2 >> 3) & 1, sy = (b2 >> 2) & 1;
      return { type: 'av1C', profile: b1 >> 5, level: b1 & 31, bitDepth: high ? (twelve ? 12 : 10) : 8, mono, chroma: mono ? 0 : sx && sy ? 1 : sx ? 2 : 3 };
    }
    case 'auxC': { const s = r.cstr(d + 4, p.end); return { type: 'auxC', auxType: s.s }; }
    case 'lsel': return { type: 'lsel', layer: r.u16(d) };
    default: return { type: p.type };
  }
}

function parseIprp(r, b) {
  const kids = boxes(r, b.data, b.end);
  const ipco = kids.find((k) => k.type === 'ipco');
  const props = ipco ? boxes(r, ipco.data, ipco.end).map((p) => { try { return parseProperty(r, p); } catch (e) { return { type: p.type, broken: true }; } }) : [];
  const assoc = new Map();
  for (const ipma of kids.filter((k) => k.type === 'ipma')) {
    const v = r.u8(ipma.data), flags = r.u32(ipma.data) & 0xffffff;
    let o = ipma.data + 4;
    const n = r.u32(o); o += 4;
    for (let i = 0; i < n && o < ipma.end; i++) {
      const id = v < 1 ? r.u16(o) : r.u32(o); o += v < 1 ? 2 : 4;
      const cnt = r.u8(o); o += 1;
      const list = assoc.get(id) || [];
      for (let k = 0; k < cnt; k++) {
        let idx;
        if (flags & 1) { idx = r.u16(o) & 0x7fff; o += 2; } else { idx = r.u8(o) & 0x7f; o += 1; }
        if (idx > 0 && props[idx - 1]) list.push(props[idx - 1]);
      }
      assoc.set(id, list);
    }
  }
  return { props, assoc };
}

const BRAND_NAMES = { heic: 'HEIC', heix: 'HEIC (10-bit or 4:2:2/4:4:4)', hevc: 'HEIC sequence', heim: 'HEIC (multi-layer)', heis: 'HEIC (scalable)', hevx: 'HEIC sequence', mif1: 'HEIF', mif2: 'HEIF', msf1: 'HEIF sequence', avif: 'AVIF', avis: 'AVIF sequence', avio: 'AVIF (intra only)', heif: 'HEIF', vvic: 'HEIF with VVC' };

/**
 * Parses the container. Returns { brand, kind: 'heic' | 'avif' | 'heif', compatible, items, primaryId, images (top-level
 * image items in file order), exif: [{ id, offset, length }], xmp: [...], sequence, warnings }.
 * Throws a plain-language Error when the file is not HEIF or AVIF.
 */
function parseContainer(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(b);
  if (b.length < 16) throw new Error('The file is too short to be a HEIC, HEIF or AVIF image.');
  if (r.fourcc(4) !== 'ftyp') throw new Error('This is not a HEIC, HEIF or AVIF file: it does not start with an "ftyp" box.');
  const top = boxes(r, 0, b.length);
  const ftyp = top.find((x) => x.type === 'ftyp');
  if (!ftyp || top[0].type !== 'ftyp') throw new Error('This is not a HEIC, HEIF or AVIF file: it does not start with an "ftyp" box.');
  const brand = r.fourcc(ftyp.data);
  const compatible = [];
  for (let o = ftyp.data + 8; o + 4 <= ftyp.end; o += 4) compatible.push(r.fourcc(o));
  const all = [brand, ...compatible];
  const kind = all.includes('avif') || all.includes('avis') ? 'avif' : all.some((x) => /^he[ivx]|^hev/.test(x)) ? 'heic' : 'heif';
  const warnings = [];
  const meta = top.find((x) => x.type === 'meta');
  const sequence = top.some((x) => x.type === 'moov');
  const out = { brand, brandName: BRAND_NAMES[brand] || brand, kind, compatible, items: [], primaryId: 0, images: [], exif: [], xmp: [], sequence, warnings, fileBytes: b.length };
  if (!meta) {
    if (sequence) { warnings.push('This file holds only an image sequence (a track), not still images.'); return out; }
    throw new Error('This file has no "meta" box, so it holds no HEIF images.');
  }
  const kids = boxes(r, meta.data + 4, meta.end);
  const get = (t) => kids.find((k) => k.type === t);
  const hdlr = get('hdlr');
  if (hdlr && r.fourcc(hdlr.data + 8) !== 'pict') warnings.push(`The meta handler is "${r.fourcc(hdlr.data + 8)}", not "pict".`);
  const pitm = get('pitm');
  if (pitm) out.primaryId = r.u8(pitm.data) === 0 ? r.u16(pitm.data + 4) : r.u32(pitm.data + 4);
  const iinf = get('iinf');
  const items = iinf ? parseIinf(r, iinf) : [];
  const iloc = get('iloc') ? parseIloc(r, get('iloc')) : new Map();
  const idat = get('idat');
  const refs = get('iref') ? parseIref(r, get('iref')) : [];
  const iprp = get('iprp') ? parseIprp(r, get('iprp')) : { props: [], assoc: new Map() };

  const byId = new Map();
  for (const it of items) {
    const loc = iloc.get(it.id) || { method: 0, extents: [] };
    it.method = loc.method;
    it.extents = loc.method === 1 && idat ? loc.extents.map((e) => ({ offset: idat.data + e.offset, length: e.length })) : loc.extents;
    it.length = it.extents.reduce((s, e) => s + e.length, 0);
    it.props = iprp.assoc.get(it.id) || [];
    it.refs = {};
    byId.set(it.id, it);
  }
  for (const ref of refs) {
    const from = byId.get(ref.from);
    if (!from) continue;
    (from.refs[ref.type] = from.refs[ref.type] || []).push(...ref.to);
  }
  const tiles = new Set(), thumbs = new Set(), aux = new Set();
  for (const it of items) {
    if (it.refs.dimg) for (const t of it.refs.dimg) tiles.add(t);
    if (it.refs.thmb) thumbs.add(it.id);
    if (it.refs.auxl) aux.add(it.id);
  }
  for (const it of items) {
    const p = (t) => it.props.find((x) => x.type === t);
    const ispe = p('ispe'), pixi = p('pixi'), hvcC = p('hvcC'), av1C = p('av1C'), irot = p('irot'), imir = p('imir'), clap = p('clap'), auxC = p('auxC');
    const colrs = it.props.filter((x) => x.type === 'colr');
    it.isImage = IMAGE_TYPES.has(it.type);
    it.codec = CODEC_NAMES[it.type] || it.type;
    it.width = ispe ? ispe.width : 0;
    it.height = ispe ? ispe.height : 0;
    if (clap && clap.width > 0 && clap.height > 0) { it.cropWidth = Math.round(clap.width); it.cropHeight = Math.round(clap.height); }
    it.rotation = irot ? irot.angle : 0;
    it.mirror = imir ? (imir.axis === 0 ? 'vertical axis (left-right)' : 'horizontal axis (top-bottom)') : '';
    it.mirrorAxis = imir ? imir.axis : -1;
    it.bitDepth = pixi && pixi.bits.length ? Math.max(...pixi.bits) : hvcC ? hvcC.bitDepth : av1C ? av1C.bitDepth : 0;
    it.channels = pixi ? pixi.channels : 0;
    const chroma = hvcC ? hvcC.chroma : av1C ? av1C.chroma : -1;
    it.chroma = chroma === 0 ? 'monochrome' : chroma === 1 ? '4:2:0' : chroma === 2 ? '4:2:2' : chroma === 3 ? '4:4:4' : '';
    it.profile = hvcC ? (HEVC_PROFILES[hvcC.profile] || `profile ${hvcC.profile}`) : av1C ? (AV1_PROFILES[av1C.profile] || `profile ${av1C.profile}`) : '';
    it.auxType = auxC ? auxC.auxType : '';
    const nclx = colrs.find((c) => c.kind === 'nclx'), icc = colrs.find((c) => c.kind === 'prof' || c.kind === 'rICC');
    it.color = {
      primaries: nclx ? (PRIMARIES[nclx.primaries] || `code ${nclx.primaries}`) : '',
      transfer: nclx ? (TRANSFERS[nclx.transfer] || `code ${nclx.transfer}`) : '',
      fullRange: nclx ? nclx.fullRange : undefined,
      icc: icc ? (icc.iccName || `${icc.iccBytes} bytes`) : '',
      p3: !!((nclx && (nclx.primaries === 12 || nclx.primaries === 11)) || (icc && /p3/i.test(icc.iccName || ''))),
      hdr: !!(nclx && (nclx.transfer === 16 || nclx.transfer === 18)),
    };
    it.isTile = tiles.has(it.id);
    it.isThumbnail = thumbs.has(it.id);
    it.isAux = aux.has(it.id);
  }
  for (const it of items) {
    if (it.type === 'grid' && it.refs.dimg) {
      const data = itemData(b, it);
      if (data && data.length >= 8) {
        const large = data[1] & 1;
        it.grid = { rows: data[2] + 1, columns: data[3] + 1, width: large ? new Reader(data).u32(4) : new Reader(data).u16(4), height: large ? new Reader(data).u32(8) : new Reader(data).u16(6), tiles: it.refs.dimg.length };
        if (!it.width) { it.width = it.grid.width; it.height = it.grid.height; }
        const first = byId.get(it.refs.dimg[0]);
        if (first) { it.tileWidth = first.width; it.tileHeight = first.height; if (!it.bitDepth) it.bitDepth = first.bitDepth; if (!it.chroma) it.chroma = first.chroma; if (!it.profile) it.profile = first.profile; it.tileCodec = first.codec; if (!it.color.primaries && !it.color.icc) it.color = first.color; }
      }
    }
    if (it.type === 'Exif') out.exif.push({ id: it.id, offset: it.extents.length === 1 ? it.extents[0].offset : -1, length: it.length, of: it.refs.cdsc || [] });
    if (it.type === 'mime' && /xmp|rdf\+xml/i.test(it.contentType || '')) out.xmp.push({ id: it.id, offset: it.extents.length === 1 ? it.extents[0].offset : -1, length: it.length, of: it.refs.cdsc || [] });
  }
  out.items = items;
  // Top-level images, as libheif counts them: image items that are not hidden, not a thumbnail and not auxiliary
  // (alpha, depth). Inputs of a grid, overlay or derived image count when the file does not hide them.
  out.images = items.filter((it) => it.isImage && !it.hidden && !it.isThumbnail && !it.isAux);
  const usedBy = new Map();
  for (const it of items) for (const t of it.refs.dimg || []) usedBy.set(t, it);
  for (const im of out.images) {
    im.primary = im.id === out.primaryId;
    im.thumbnails = items.filter((t) => t.isThumbnail && (t.refs.thmb || []).includes(im.id)).map((t) => `${t.width} x ${t.height}`);
    const auxOf = items.filter((t) => t.isAux && (t.refs.auxl || []).includes(im.id));
    // HEVC names alpha "urn:mpeg:hevc:2015:auxid:1" and depth "...auxid:2"; AVIF uses "...:auxiliary:alpha".
    const isAlpha = (t) => /alpha|hevc:2015:auxid:1$/i.test(t.auxType);
    const isDepth = (t) => /depth|disparity|hevc:2015:auxid:2$/i.test(t.auxType);
    im.alpha = auxOf.some(isAlpha);
    im.depth = auxOf.some(isDepth);
    im.otherAux = auxOf.filter((t) => !isAlpha(t) && !isDepth(t)).map((t) => t.auxType || t.type);
    im.exifIds = out.exif.filter((e) => e.of.includes(im.id)).map((e) => e.id);
    im.display = displaySize(im);
    const parent = usedBy.get(im.id);
    im.inputOf = parent ? `${parent.codec.toLowerCase()} ${parent.id}` : '';
  }
  if (!out.images.length && !sequence) warnings.push('No still image is listed in this file.');
  if (out.primaryId && !byId.has(out.primaryId)) warnings.push(`The primary item ${out.primaryId} is not in the item list.`);
  return out;
}

/** Width and height after the crop (clap) and rotation (irot) the viewer applies. */
function displaySize(it) {
  const w = it.cropWidth || it.width, h = it.cropHeight || it.height;
  return it.rotation === 90 || it.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** The bytes of one item (all its extents joined), or null when they are outside the file. */
function itemData(buf, it) {
  const parts = [];
  for (const e of it.extents || []) {
    if (e.offset < 0 || e.offset + e.length > buf.length) return null;
    parts.push(buf.subarray(e.offset, e.offset + e.length));
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The TIFF part of an Exif item (after the 4-byte header offset), with its position in the file when it is one extent. */
function exifTiff(buf, item) {
  const it = typeof item === 'object' && item.extents ? item : null;
  const data = it ? itemData(buf, it) : null;
  if (!data || data.length < 12) return null;
  const skip = ((data[0] << 24) >>> 0) + (data[1] << 16) + (data[2] << 8) + data[3];
  let o = 4 + skip;
  // Some writers leave out the offset or point at "Exif\0\0": find the TIFF header near the start.
  const isTiff = (k) => (data[k] === 0x4d && data[k + 1] === 0x4d && data[k + 2] === 0 && data[k + 3] === 42) || (data[k] === 0x49 && data[k + 1] === 0x49 && data[k + 2] === 42 && data[k + 3] === 0);
  if (!isTiff(o)) { o = -1; for (let k = 0; k < Math.min(32, data.length - 4); k++) if (isTiff(k)) { o = k; break; } }
  if (o < 0) return null;
  const fileOffset = it.extents.length === 1 ? it.extents[0].offset + o : -1;
  return { tiff: data.subarray(o), fileOffset };
}

module.exports = { parseContainer, itemData, exifTiff, displaySize, boxes, Reader, CODEC_NAMES, BRAND_NAMES };
